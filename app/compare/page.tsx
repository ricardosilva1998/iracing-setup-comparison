import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// /compare is preserved as a permanent redirect to / so existing bookmarks
// (Railway production URL, the team-deployment QA-curl commands sprinkled
// across CLAUDE.md) keep working after / became the comparison view.
export default async function ComparePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v) && v[0]) qs.set(k, v[0]);
  }
  const tail = qs.toString();
  redirect(tail ? `/?${tail}` : "/");
}
