import type { ErrorExtended } from "@shared";
import { ServerErrorFallback } from "@/components/error-fallback";
import { type GetToolsResponses, getTools } from "@/lib/clients/api";
import { getServerApiHeaders } from "@/lib/server-utils";
import { ToolsPage } from "./page.client";

export const dynamic = "force-dynamic";

export default async function ToolsPageServer() {
  let initialData: GetToolsResponses["200"] | undefined;
  try {
    const headers = await getServerApiHeaders();
    initialData = (await getTools({ headers })).data;
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <ToolsPage initialData={initialData} />;
}
