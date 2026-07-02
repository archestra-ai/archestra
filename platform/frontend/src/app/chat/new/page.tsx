"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Chat New Page - Redirects to chat with pre-selected agent, auto-sent
 * message, and/or pre-staged skill
 *
 * URL format:
 *   /chat/new?agent_id=<prompt_uuid>&user_prompt=<message>&skill_id=<skill_uuid>
 *
 * Note: agent_id maps to agentId, skill_id maps to skillId URL parameters
 */
export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const agentId = searchParams.get("agent_id");
    const userPrompt = searchParams.get("user_prompt");
    const skillId = searchParams.get("skill_id");

    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (userPrompt) params.set("user_prompt", userPrompt);
    if (skillId) params.set("skillId", skillId);

    const queryString = params.toString();
    router.replace(queryString ? `/chat?${queryString}` : "/chat");
  }, [searchParams, router]);

  return null;
}
