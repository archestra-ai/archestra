"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Chat New Page - Redirects to chat with pre-selected agent and auto-sent message
 *
 * URL format:
 *   /chat/new?agent_id=<prompt_uuid>&user_prompt=<message>
 *
 * Note: agent_id maps to agentId URL parameter
 */
export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const agentId = searchParams.get("agent_id");
    const userPrompt = searchParams.get("user_prompt");

    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (userPrompt) params.set("user_prompt", userPrompt);

    router.replace(`/chat?${params.toString()}`);
  }, [searchParams, router]);

  return null;
}
