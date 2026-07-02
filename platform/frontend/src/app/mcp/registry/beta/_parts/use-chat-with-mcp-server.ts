"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useState } from "react";
import { toast } from "sonner";
import { fetchInternalAgents, useCreateProfile } from "@/lib/agent.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useSession } from "@/lib/auth/auth.query";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * Get-or-create a personal agent named after the catalog item, assign it the
 * item's tools, and navigate to a chat with it. Shared by the server card and
 * the item detail page.
 */
export function useChatWithMcpServer(item: CatalogItem) {
  const createAgent = useCreateProfile();
  const bulkAssignTools = useBulkAssignTools();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const [isChatCreating, setIsChatCreating] = useState(false);

  const startChat = async () => {
    setIsChatCreating(true);
    const agentName = item.name;
    try {
      // Get or create: check if a personal agent with this name already exists for the current user
      const existingAgents = await fetchInternalAgents();
      const existing = existingAgents?.find(
        (a) => a.name === agentName && a.authorId === currentUserId,
      );

      const agent =
        existing ??
        (await createAgent.mutateAsync({
          name: agentName,
          agentType: "agent",
          scope: "personal",
          teams: [],
          icon: item.icon ?? undefined,
        }));

      const tools = await fetchCatalogTools(item.id);

      if (agent && tools && tools.length > 0) {
        const assignments = tools.map((tool) => ({
          agentId: agent.id,
          toolId: tool.id,
          resolveAtCallTime: true,
          ...(item.enterpriseManagedConfig
            ? { credentialResolutionMode: "enterprise_managed" as const }
            : {}),
        }));
        await bulkAssignTools.mutateAsync({ assignments });
      }

      if (agent) {
        window.location.href = `/chat/new?agent_id=${agent.id}`;
      }
    } catch {
      toast.error("Failed to create chat agent");
    } finally {
      setIsChatCreating(false);
    }
  };

  return { startChat, isChatCreating };
}
