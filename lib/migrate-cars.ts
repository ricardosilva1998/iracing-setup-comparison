/**
 * One-shot, idempotent car-name canonicalisation migration.
 *
 * Round 13 added `lib/car-name-canonical.ts` and updated all scrapers to call
 * `canonicalizeCarName(rawName)` before upserting Car rows. New scrapes
 * therefore write canonical names directly.
 *
 * However, EXISTING Car rows in production (and any non-fresh local dev.db)
 * still hold the non-canonical raw names from earlier scrapes -- "Aston Martin
 * GT3" (GnG) sits next to "Aston Martin Vantage GT3 EVO" (HYMO); their
 * SetupListing children point to the orphan rows; the comparison page shows
 * two adjacent rows for the same physical car. This module collapses those
 * orphans into the canonical Car row and repoints SetupListings.
 *
 * Idempotency:
 *   - Run as many times as you like. After the first run there are no
 *     orphans left so subsequent runs are a no-op.
 *   - Safe to call from `/api/ingest` BEFORE the scrapers each time.
 *
 * Collision handling (the SetupListing composite key is
 * (shopId, carId, trackId, seasonWeekId)):
 *   - When repointing an orphan SetupListing to the canonical Car, a row
 *     may already exist for the same (shop, canonicalCar, track, week)
 *     because HYMO already wrote the canonical name and GnG wrote the orphan
 *     name for the same (car, track, week) combination.
 *   - When that happens we KEEP the row whose lapTime has data (lap-time
 *     is the load-bearing signal), with `updatedAt` as the tiebreaker.
 *     We delete the loser (cascading its LapTime via the Prisma relation).
 *   - All work happens inside a single Prisma transaction so a half-run
 *     cannot leave the DB in a weird state.
 */
import type { PrismaClient } from "../app/generated/prisma/client";
import { canonicalizeCarName } from "./car-name-canonical";
import { lookupCanonicalClass } from "./car-class-canonical";

export type CarMigrationResult = {
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
export async function migrateCars(prisma: PrismaClient): Promise<CarMigrationResult> {
  const result: CarMigrationResult = {
    inspected: 0,
    orphansFound: 0,
    listingsRepointed: 0,
    collisionsResolved: 0,
    orphansDeleted: 0,
  };

  // Read the full Car set up front (small; <200 rows expected).
  const allCars = await prisma.car.findMany({
    select: { id: true, name: true, carClass: true, categoryId: true },
    orderBy: { id: "asc" },
  });
  result.inspected = allCars.length;

  // Build the orphan list outside the transaction so we can short-circuit
  // when there's nothing to do (idempotent fast path).
  type Orphan = {
    id: number;
    name: string;
    carClass: string;
    categoryId: number;
    canonical: string;
  };
  const orphans: Orphan[] = [];
  for (const c of allCars) {
    const canonical = canonicalizeCarName(c.name);
    if (canonical !== c.name) {
      orphans.push({
        id: c.id,
        name: c.name,
        carClass: c.carClass,
        categoryId: c.categoryId,
        canonical,
      });
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
      // 1. Find or create the canonical Car row.
      //    If the canonical row already exists (i.e. HYMO already wrote it),
      //    keep its existing class -- HYMO's class is the reference per the
      //    round-3 invariant. If we are creating a fresh canonical row,
      //    derive the class via lookupCanonicalClass (DB lookup -> name regex
      //    -> fallback = orphan's class).
      const existingCanonical = await tx.car.findUnique({
        where: { name: orphan.canonical },
        select: { id: true, carClass: true, categoryId: true },
      });

      let canonicalCarId: number;
      if (existingCanonical) {
        // Canonical row already exists -- reuse it.
        canonicalCarId = existingCanonical.id;
      } else {
        // Create the canonical Car row.
        // lookupCanonicalClass will miss the DB (no row yet for this name),
        // then try name-regex rules, then fall back to the orphan's class.
        const resolvedClass = await lookupCanonicalClass(
          tx as unknown as PrismaClient,
          orphan.canonical,
          orphan.carClass,
        );
        const created = await tx.car.create({
          data: {
            name: orphan.canonical,
            carClass: resolvedClass,
            categoryId: orphan.categoryId,
          },
        });
        canonicalCarId = created.id;
      }

      // 2. Reassign all SetupListings pointing at the orphan to the canonical.
      //    We handle the (shopId, carId, trackId, seasonWeekId) unique-key
      //    collision row-by-row -- a bulk updateMany would throw on violation.
      const orphanListings = await tx.setupListing.findMany({
        where: { carId: orphan.id },
        include: { lapTime: true },
      });

      for (const ol of orphanListings) {
        // Look for an existing canonical row that would collide.
        const colliding = await tx.setupListing.findUnique({
          where: {
            shopId_carId_trackId_seasonWeekId: {
              shopId: ol.shopId,
              carId: canonicalCarId,
              trackId: ol.trackId,
              seasonWeekId: ol.seasonWeekId,
            },
          },
          include: { lapTime: true },
        });

        if (!colliding) {
          // No collision: simple repoint.
          await tx.setupListing.update({
            where: { id: ol.id },
            data: { carId: canonicalCarId },
          });
          result.listingsRepointed++;
          continue;
        }

        // Collision. Pick a winner.
        // Prefer the row that has a LapTime (the load-bearing signal). If
        // both or neither have one, prefer the later `updatedAt`. Delete the
        // loser (cascades its LapTime via the schema onDelete relation).
        const olHasLap = ol.lapTime != null;
        const collidingHasLap = colliding.lapTime != null;

        let keepOrphan: boolean;
        if (olHasLap !== collidingHasLap) {
          keepOrphan = olHasLap;
        } else {
          keepOrphan = ol.updatedAt > colliding.updatedAt;
        }

        if (keepOrphan) {
          // Delete the colliding (canonical-carId) row first to free the
          // unique key, then repoint the orphan listing.
          await tx.setupListing.delete({ where: { id: colliding.id } });
          await tx.setupListing.update({
            where: { id: ol.id },
            data: { carId: canonicalCarId },
          });
        } else {
          // Keep the existing canonical-carId row; drop the orphan listing.
          await tx.setupListing.delete({ where: { id: ol.id } });
        }
        result.collisionsResolved++;
      }

      // 3. Delete the now-empty orphan Car row.
      //    Sanity check: confirm no SetupListing still points at it.
      const remaining = await tx.setupListing.count({
        where: { carId: orphan.id },
      });
      if (remaining === 0) {
        await tx.car.delete({ where: { id: orphan.id } });
        result.orphansDeleted++;
      }
    }
  });

  return result;
}
