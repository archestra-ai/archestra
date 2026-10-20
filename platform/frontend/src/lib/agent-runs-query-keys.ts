/**
 * The caller's own Agent Runtime runs, as the sidebar and the search palette
 * list them. No React here: the server seed keys its reads with these.
 */
// A sidebar page. The sidebar renders every loaded run and offers "load
// more", so a short first page keeps the 79 KB-per-hundred payload out of
// every page's request burst; the palette pages further on demand.
export const MY_AGENT_RUNS_PAGE_SIZE = 20;

export type MyAgentRunsOptions = { pinned?: boolean; search?: string };

export function myAgentRunsQueryKey(options: MyAgentRunsOptions = {}) {
  return ["agent-runs", "mine", options] as const;
}

/** The query a list's page sends, starting at `offset`. */
export function myAgentRunsPageQuery(
  options: MyAgentRunsOptions,
  offset: number,
) {
  return {
    limit: MY_AGENT_RUNS_PAGE_SIZE,
    offset,
    sort: options.pinned ? ("pinned" as const) : ("recent" as const),
    ...options,
  };
}

/** The sidebar's two run lists: recent and pinned. */
export const SIDEBAR_RECENT_RUNS: MyAgentRunsOptions = { pinned: false };
export const SIDEBAR_PINNED_RUNS: MyAgentRunsOptions = { pinned: true };
