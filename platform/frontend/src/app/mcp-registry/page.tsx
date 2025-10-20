import type { ErrorExtended } from "@shared";
import { ServerErrorFallback } from "@/components/error-fallback";
import {
  type GetMcpCatalogResponses,
  type GetMcpServersResponses,
  getMcpCatalog,
  getMcpServers,
} from "@/lib/clients/api";
import { getServerApiHeaders } from "@/lib/server-utils";
import McpRegistryPage from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpRegistryPageServer() {
  let initialData: {
    catalog: GetMcpCatalogResponses["200"];
    servers: GetMcpServersResponses["200"];
  } = {
    catalog: [],
    servers: [],
  };

  try {
    const headers = await getServerApiHeaders();
    initialData = {
      catalog: (await getMcpCatalog({ headers })).data || [],
      servers: (await getMcpServers({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpRegistryPage initialData={initialData} />;
}
