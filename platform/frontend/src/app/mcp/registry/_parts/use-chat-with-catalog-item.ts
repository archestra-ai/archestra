"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { fetchInternalAgents, useCreateProfile } from "@/lib/agent.query";
import { useBulkAssignTools } from "@/lib/agent-tools.query";
import { useSession } from "@/lib/auth/auth.query";
import { fetchCatalogTools } from "@/lib/mcp/internal-mcp-catalog.query";

type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

/**
 * "Chat with this MCP server": gets or creates a personal agent named after
 * the catalog item, assigns the catalog's tools to it (resolved at call
 * time), and navigates to a new chat with that agent.
 *
 * Shared by the registry card and the catalog-item detail page so both
 * entry points behave identically.
 */
export function useChatWithCatalogItem() {
  const router = useRouter();
  const createAgent = useCreateProfile();
  const bulkAssignTools = useBulkAssignTools();
  const [isCreating, setIsCreating] = useState(false);

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const startChat = async (item: CatalogItem) => {
    setIsCreating(true);
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
        // Client-side nav (the app's convention — /chat/new itself just
        // router.replace()s onward) so we don't hard-reload the SPA.
        router.push(`/chat/new?agent_id=${agent.id}`);
      }
    } catch {
      toast.error("Failed to create chat agent");
    } finally {
      setIsCreating(false);
    }
  };

  return { startChat, isCreating };
}
