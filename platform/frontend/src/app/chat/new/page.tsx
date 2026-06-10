"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Chat New Page - Redirects to chat with pre-selected agent and auto-sent message
 *
 * URL format:
 *   /chat/new?agent_id=<prompt_uuid>&project_id=<project_uuid>&user_prompt=<message>
 *
 * Note: agent_id maps to agentId URL parameter
 */
export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const agentId = searchParams.get("agent_id");
    const projectId = searchParams.get("project_id");
    const modelId = searchParams.get("model_id");
    const chatApiKeyId = searchParams.get("chat_api_key_id");
    const userPrompt = searchParams.get("user_prompt");

    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (projectId) params.set("projectId", projectId);
    if (modelId) params.set("modelId", modelId);
    if (chatApiKeyId) params.set("chatApiKeyId", chatApiKeyId);
    if (userPrompt) params.set("user_prompt", userPrompt);

    const queryString = params.toString();
    router.replace(queryString ? `/chat?${queryString}` : "/chat");
  }, [searchParams, router]);

  return null;
}
