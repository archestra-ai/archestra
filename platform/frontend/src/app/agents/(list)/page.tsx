import AgentsPage from "../page.client";
import { StreamedAgentsPage } from "../streamed-agents-page";

export const dynamic = "force-dynamic";

// The catalog's main list can take seconds, so the page never waits on it:
// the default view's queries start on the server and stream to the browser
// while the page renders behind its loading states. Any other view (search
// parameters set) loads on the client. Access is the root layout's page
// guard, from the permissions the browser already holds; a server check here
// would hold the first flush for a request of its own.
//
// The two fast reads the catalog's keys depend on are awaited here, behind the
// route's loading boundary. Returning the page first, with a Suspense fallback
// of its own, would put the page's code in the HTML's first scripts, where it
// competes with the shell's own on a slow network.
export default async function AgentsPageServer({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (Object.keys(await searchParams).length > 0) return <AgentsPage />;
  return await StreamedAgentsPage();
}
