"use client";

import type { archestraApiTypes } from "@shared";
import Divider from "@/components/divider";
import { ExternalMCPCatalog } from "../_parts/ExternalMCPCatalog";
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
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8">
      <InternalMCPCatalog
        initialData={initialData.catalog}
        installedServers={initialData.servers}
      />
      <Divider className="my-8" />
      <ExternalMCPCatalog catalogItems={initialData.catalog} />
    </div>
  );
}
