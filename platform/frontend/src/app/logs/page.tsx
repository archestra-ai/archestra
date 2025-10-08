import {
  type GetInteractionsResponses,
  getInteractions,
} from "@shared/api-client";
import LogsPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function LogsPageServer() {
  let initialData: GetInteractionsResponses["200"] | undefined;
  try {
    initialData = (await getInteractions()).data;
  } catch (error) {
    console.error(error);
  }
  return <LogsPage initialData={initialData} />;
}
