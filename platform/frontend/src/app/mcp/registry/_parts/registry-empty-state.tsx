"use client";

import { Plus, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";

export function RegistryEmptyState() {
  const router = useRouter();

  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Server />
        </EmptyMedia>
        <EmptyTitle>No MCP servers installed yet</EmptyTitle>
        <EmptyDescription>
          Add a server from the catalog to make its tools available to agents.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <PermissionButton
          permissions={{ mcpRegistry: ["create"] }}
          onClick={() => router.push("/mcp/registry/new")}
        >
          <Plus className="h-4 w-4" />
          Add MCP Server
        </PermissionButton>
      </EmptyContent>
    </Empty>
  );
}
