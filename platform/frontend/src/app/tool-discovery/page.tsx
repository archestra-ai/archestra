import { type GetToolsResponses, getTools } from "shared/api-client";
import { ToolDiscoveryPage } from "./page.client";

export default async function ToolDiscoveryPageServer() {
  let initialData: GetToolsResponses["200"] | undefined;
  try {
    initialData = (await getTools()).data;
  } catch (error) {
    console.error(error);
  }

  return <ToolDiscoveryPage initialData={initialData} />;
}
