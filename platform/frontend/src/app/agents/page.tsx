import { type GetAgentsResponses, getAgents } from "@/lib/clients/api";
import AgentsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function AgentsPageServer() {
  let initialData: GetAgentsResponses["200"] = [];
  try {
    initialData = (await getAgents()).data || [];
  } catch (error) {
    console.error(error);
  }
  return <AgentsPage initialData={initialData} />;
}
