/**
 * One-shot, idempotent track-canonicalisation migration.
 *
 * Round 9 added `lib/track-canonical.ts` and updated both scrapers to call
 * `canonicalizeTrackName(rawName)` before upserting Track rows. New scrapes
 * therefore write canonical names directly.
 *
 * However, EXISTING Track rows in production (and any non-fresh local dev.db)
 * still hold the non-canonical raw names from earlier scrapes -- "Adelaide"
 * (HYMO) sits next to "Adelaide Street Circuit" (GnG); their SetupListing
 * children point to the orphan rows; the comparison page shows two adjacent
 * rows for the same physical track. This module collapses those orphans
 * into the canonical Track row and repoints SetupListings.
 *
 * Idempotency:
 *   - Run as many times as you like. After the first run there are no
 *     orphans left so subsequent runs are no-ops.
 *   - Safe to call from `/api/ingest` BEFORE the scrapers each time.
 *
 * Collision handling (the SetupListing composite key is
 * (shopId, carId, trackId, seasonWeekId)):
 *   - When repointing an orphan SetupListing to the canonical Track, a row
 *     may already exist for the same (shop, car, canonicalTrack, week)
 *     because both shops scraped the same track under their own naming and
 *     each created a listing.
 *   - When that happens we KEEP the row whose lapTime has data (lap-time
 *     is the load-bearing signal), with `updatedAt` as the tiebreaker.
 *     We delete the loser (cascading its LapTime via the Prisma relation).
 *   - All work happens inside a single Prisma transaction so a half-run
 *     cannot leave the DB in a weird state.
 */
import type { PrismaClient } from "../app/generated/prisma/client";
import { canonicalizeTrackName } from "./track-canonical";

export type TrackMigrationResult = {
  inspected: number;
  orphansFound: number;
  listingsRepointed: number;
  collisionsResolved: number;
  orphansDeleted: number;
};

/**
 * Run the migration. The supplied prisma client must be the same instance
 * the scrapers will use. The migration runs entirely inside a transaction.
 */
export async function migrateTracks(prisma: PrismaClient): Promise<TrackMigrationResult> {
  const result: TrackMigrationResult = {
    inspected: 0,
    orphansFound: 0,
    listingsRepointed: 0,
    collisionsResolved: 0,
    orphansDeleted: 0,
  };

  // Read the full Track set up front (small; <100 rows expected).
  const allTracks = await prisma.track.findMany({
    select: { id: true, name: true },
    orderBy: { id: "asc" },
  });
  result.inspected = allTracks.length;

  // Build the orphan list outside the transaction so we can short-circuit
  // when there's nothing to do (idempotent fast path).
  type Orphan = { id: number; name: string; canonical: string };
  const orphans: Orphan[] = [];
  for (const t of allTracks) {
    const canonical = canonicalizeTrackName(t.name);
    if (canonical !== t.name) {
      orphans.push({ id: t.id, name: t.name, canonical });
    }
  }
  result.orphansFound = orphans.length;

  if (orphans.length === 0) {
    // Nothing to migrate.
    return result;
  }

  // All write work in one transaction.
  await prisma.$transaction(async (tx) => {
    for (const orphan of orphans) {
      // 1. Find or create the canonical Track row.
      const canonicalTrack = await tx.track.upsert({
        where: { name: orphan.canonical },
        create: { name: orphan.canonical },
        update: {},
      });

      // 2. Reassign all SetupListings pointing at the orphan to the canonical.
      //    We have to handle the (shopId, carId, trackId, seasonWeekId)
      //    unique-key collision row-by-row -- a bulk updateMany would throw.
      const orphanListings = await tx.setupListing.findMany({
        where: { trackId: orphan.id },
        include: { lapTime: true },
      });

      for (const ol of orphanListings) {
        // Look for an existing canonical row that would collide.
        const colliding = await tx.setupListing.findUnique({
          where: {
            shopId_carId_trackId_seasonWeekId: {
              shopId: ol.shopId,
              carId: ol.carId,
              trackId: canonicalTrack.id,
              seasonWeekId: ol.seasonWeekId,
            },
          },
          include: { lapTime: true },
        });

        if (!colliding) {
          // No collision: simple repoint.
          await tx.setupListing.update({
            where: { id: ol.id },
            data: { trackId: canonicalTrack.id },
          });
          result.listingsRepointed++;
          continue;
        }

        // Collision. Pick a winner.
        // Prefer the row that has a LapTime; if both or neither have one,
        // prefer the one with the later `updatedAt`. Delete the loser
        // (which cascades its LapTime via the schema relation).
        const olHasLap = ol.lapTime != null;
        const collidingHasLap = colliding.lapTime != null;

        let keepOrphan: boolean;
        if (olHasLap !== collidingHasLap) {
          keepOrphan = olHasLap;
        } else {
          keepOrphan = ol.updatedAt > colliding.updatedAt;
        }

        if (keepOrphan) {
          // Delete the colliding (canonical-trackId) row first to free the
          // unique key, then repoint the orphan listing.
          await tx.setupListing.delete({ where: { id: colliding.id } });
          await tx.setupListing.update({
            where: { id: ol.id },
            data: { trackId: canonicalTrack.id },
          });
        } else {
          // Keep the existing canonical-trackId row; drop the orphan listing.
          await tx.setupListing.delete({ where: { id: ol.id } });
        }
        result.collisionsResolved++;
      }

      // 3. Delete the now-empty orphan Track row.
      // Sanity check: confirm no SetupListing still points at it.
      const remaining = await tx.setupListing.count({
        where: { trackId: orphan.id },
      });
      if (remaining === 0) {
        await tx.track.delete({ where: { id: orphan.id } });
        result.orphansDeleted++;
      }
    }
  });

  return result;
}
