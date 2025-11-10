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
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">
      <InternalMCPCatalog
        initialData={initialData.catalog}
        installedServers={initialData.servers}
      />
    </div>
  );
}
