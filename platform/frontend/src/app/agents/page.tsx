import { type GetAgentsResponses, getAgents } from "@/lib/clients/api";
import { getServerApiHeaders } from "@/lib/server-utils";
import AgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AgentsPageServer() {
  let initialData: GetAgentsResponses["200"] = [];
  try {
    const headers = await getServerApiHeaders();
    initialData = (await getAgents({ headers })).data || [];
  } catch (error) {
    console.error(error);
  }
  return <AgentsPage initialData={initialData} />;
}
