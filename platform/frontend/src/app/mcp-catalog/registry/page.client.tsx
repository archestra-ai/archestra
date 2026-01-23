"use client";

// Non-user-facing build marker to test chunk hashing during deployments
const _BUILD_TEST_MARKER = "chunk-hash-test-20260123";
void _BUILD_TEST_MARKER;

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
