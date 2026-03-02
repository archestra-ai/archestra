import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@shared";

import { ServerErrorFallback } from "@/components/error-fallback";
import { getServerApiHeaders } from "@/lib/server-utils";
import { handleApiError } from "@/lib/utils";
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
    const [catalogResponse, serversResponse] = await Promise.all([
      archestraApiSdk.getInternalMcpCatalog({ headers }),
      archestraApiSdk.getMcpServers({ headers }),
    ]);
    if (catalogResponse.error) {
      handleApiError(catalogResponse.error);
    }
    if (serversResponse.error) {
      handleApiError(serversResponse.error);
    }
    initialData = {
      catalog: catalogResponse.data || [],
      servers: serversResponse.data || [],
    };
  } catch (error) {
    return <ServerErrorFallback error={error as ErrorExtended} />;
  }

  return <McpRegistryClient initialData={initialData} />;
}
