import { type GetToolsResponses, getTools } from "shared/api-client";
import { ToolsPage } from "./page.client";

export default async function ToolsPageServer() {
  let initialData: GetToolsResponses["200"] | undefined;
  try {
    initialData = (await getTools()).data;
  } catch (error) {
    console.error(error);
  }

  return <ToolsPage initialData={initialData} />;
}
