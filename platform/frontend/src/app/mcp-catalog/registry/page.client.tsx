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
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
      <InternalMCPCatalog
        initialData={initialData.catalog}
        installedServers={initialData.servers}
      />
    </div>
  );
}
