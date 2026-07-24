import ReviewPage from "./page.client";

// The recording bundle is fetched per-request from GitHub (via the backend);
// never statically prerender this route.
export const dynamic = "force-dynamic";

/**
 * The reviewer opens a submission with a link the hackathon MCP builds:
 * `/review?sub=…&src=…&pr=…&repo=…&app=…&by=…&name=…&cat=…`. Query params are
 * read server-side and handed to the client host, which fetches the bundle and
 * mounts the read-only review player.
 */
export default async function ReviewPageServer({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  return (
    <ReviewPage
      sub={first("sub")}
      src={first("src")}
      pr={first("pr")}
      repo={first("repo")}
      app={first("app")}
      by={first("by")}
      name={first("name")}
      cat={first("cat")}
    />
  );
}
