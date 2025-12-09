import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import McpRegistryClient from "./page.client";

export const dynamic = "force-dynamic";

export default async function McpRegistryPage() {
  let initialData: {
    catalog: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
    servers: archestraApiTypes.GetMcpServersResponses["200"];
  } = {
    catalog: [],
    servers: [],
  };

  try {
    const headers = await getServerApiHeaders();
    initialData = {
      catalog:
        (await archestraApiSdk.getInternalMcpCatalog({ headers })).data || [],
      servers: (await archestraApiSdk.getMcpServers({ headers })).data || [],
    };
  } catch (error) {
    console.error(error);
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpRegistryClient initialData={initialData} />;
}
