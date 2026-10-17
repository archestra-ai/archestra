import { getServerApiHeaders } from "@/lib/utils/server";
import AgentsPage from "./page.client";
import { streamAgentCatalog } from "./stream-agent-catalog";
import { StreamedQueries } from "./streamed-queries";

/**
 * The Agents page's default view once the viewer's automatic pins are known
 * (two fast reads); the catalog queries it starts are not awaited. The page
 * renders it inside a Suspense boundary so the route flushes before these
 * reads answer.
 */
export async function StreamedAgentsPage() {
  const streamed = await getServerApiHeaders()
    .then(streamAgentCatalog)
    .catch(() => null);
  return streamed ? (
    <StreamedQueries state={streamed}>
      <AgentsPage />
    </StreamedQueries>
  ) : (
    <AgentsPage />
  );
}
