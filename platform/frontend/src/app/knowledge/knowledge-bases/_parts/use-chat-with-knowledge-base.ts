"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useCreateProfile, useUpdateProfile } from "@/lib/agent.query";
import { fetchInternalAgentOptionByName } from "@/lib/agent-options.query";
import { useSession } from "@/lib/auth/auth.query";
import { throwOnApiError } from "@/lib/utils/api";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

/**
 * "Talk to this knowledge base": gets or creates a personal agent named after
 * the knowledge base, assigns the knowledge base to it (so the agent gets the
 * `query_knowledge_sources` tool), and navigates to a new chat with that agent.
 *
 * Mirrors `useChatWithCatalogItem` (the "Chat with this MCP server" flow) so
 * both entry points behave identically.
 */
export function useChatWithKnowledgeBase() {
  const router = useRouter();
  const createAgent = useCreateProfile();
  const updateAgent = useUpdateProfile();
  const [isCreating, setIsCreating] = useState(false);

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const startChat = async (knowledgeBase: KnowledgeBaseItem) => {
    setIsCreating(true);
    const agentName = knowledgeBase.name;
    try {
      // Get or create: check if a personal agent with this name already exists
      // for the current user.
      const existing = await fetchInternalAgentOptionByName({
        name: agentName,
        authorId: currentUserId,
      });

      let agent: { id: string } | undefined = existing;
      if (existing) {
        const { data: selectedAgent, error } = await archestraApiSdk.getAgent({
          path: { id: existing.id },
        });
        throwOnApiError(error, { toastOnError: false });
        if (!selectedAgent) throw new Error("Agent details are unavailable");
        // Reuse the agent, ensuring this knowledge base is assigned to it.
        if (!selectedAgent.knowledgeBaseIds?.includes(knowledgeBase.id)) {
          agent = await updateAgent.mutateAsync({
            id: existing.id,
            data: {
              knowledgeBaseIds: [
                ...(selectedAgent.knowledgeBaseIds ?? []),
                knowledgeBase.id,
              ],
            },
          });
        }
      } else {
        agent = await createAgent.mutateAsync({
          name: agentName,
          agentType: "agent",
          knowledgeBaseIds: [knowledgeBase.id],
        });
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
