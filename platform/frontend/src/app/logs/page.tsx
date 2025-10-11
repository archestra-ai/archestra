import {
  type GetAgentsResponses,
  type GetInteractionsResponses,
  getAgents,
  getInteractions,
} from "@/lib/clients/api";
import LogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LogsPageServer() {
  let initialData: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  } = {
    interactions: [],
    agents: [],
  };
  try {
    initialData = {
      interactions: (await getInteractions()).data || [],
      agents: (await getAgents()).data || [],
    };
  } catch (error) {
    console.error(error);
  }
  return <LogsPage initialData={initialData} />;
}
