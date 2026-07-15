import {
  archestraApiSdk,
  type archestraApiTypes,
  type ErrorExtended,
} from "@archestra/shared";

import { ForbiddenPage } from "@/app/_parts/forbidden-page";
import { ServerErrorFallback } from "@/components/error-fallback";
import { serverCanAccessPage } from "@/lib/auth/auth.server";
import { handleApiError } from "@/lib/utils";
import { getServerApiHeaders } from "@/lib/utils/server";
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
    if (!(await serverCanAccessPage("/mcp/registry"))) {
      return <ForbiddenPage />;
    }

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
