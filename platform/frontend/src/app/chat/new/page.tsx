"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Chat New Page - Redirects to chat with pre-selected agent and auto-sent message
 *
 * URL format:
 *   /chat/new?agent_id=<prompt_uuid>&user_prompt=<message>
 *
 * Note: agent_id refers to the Prompt ID (maps to promptId internally)
 */
export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const agentId = searchParams.get("agent_id");
    const userPrompt = searchParams.get("user_prompt");

    const params = new URLSearchParams();
    if (agentId) params.set("promptId", agentId);
    if (userPrompt) params.set("user_prompt", userPrompt);

    router.replace(`/chat?${params.toString()}`);
  }, [searchParams, router]);

  return (
    <span id="chunk-test" style={{ visibility: "hidden" }}>
      {" "}
    </span>
  );
}
