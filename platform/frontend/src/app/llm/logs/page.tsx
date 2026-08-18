import LlmProxyLogsPage from "./page.client";

export const dynamic = "force-dynamic";

// No server-side data prefetch here: the sessions table is client-fetched, and
// prefetching the agent roster for the filter dropdown serialized every agent
// into the RSC payload on each render only for the client to refetch it anyway.
export default function LlmProxyLogsPageServer() {
  return <LlmProxyLogsPage />;
}
