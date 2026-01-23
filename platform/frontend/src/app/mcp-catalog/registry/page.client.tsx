"use client";

import type { archestraApiTypes } from "@shared";
import { InternalMCPCatalog } from "../_parts/InternalMCPCatalog";

export default function McpRegistryClient({
  initialData,
}: {
  initialData: {
    catalog: archestraApiTypes.GetInternalMcpCatalogResponses["200"];
    servers: archestraApiTypes.GetMcpServersResponses["200"];
  };
}) {
  return (
    <div>
      <InternalMCPCatalog
        initialData={initialData.catalog}
        installedServers={initialData.servers}
      />
    </div>
  );
}
