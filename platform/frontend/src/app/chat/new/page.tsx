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
 * External MCP Skill handoffs additionally carry mcp_skill_id,
 * mcp_server_id, mcp_skill_uri, mcp_skill_name, mcp_server_name, and
 * mcp_skill_display_name.
 *
 * Hackathon review deep link (the Slack "Replay" button): the same URL also
 * carries `review=<submissionId>&reviewSrc=<rawUrl>&pr=&repo=&app=&by=&name=&cat=`,
 * which compose with agent_id/user_prompt so the review opens INSIDE a chat with
 * the Hackathon agent — the replay docks in the right panel. These are forwarded
 * verbatim to `/chat`, which seeds the per-conversation review context.
 */
const REVIEW_PARAM_KEYS = [
  "review",
  "reviewSrc",
  "pr",
  "repo",
  "app",
  "by",
  "name",
  "cat",
] as const;

export default function ChatNewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const agentId = searchParams.get("agent_id");
    const userPrompt = searchParams.get("user_prompt");
    const skillId = searchParams.get("skill_id");
    const externalMcpSkillId = searchParams.get("mcp_skill_id");
    const externalMcpServerId = searchParams.get("mcp_server_id");
    const externalMcpSkillUri = searchParams.get("mcp_skill_uri");
    const externalMcpSkillName = searchParams.get("mcp_skill_name");
    const externalMcpServerName = searchParams.get("mcp_server_name");
    const externalMcpSkillDisplayName = searchParams.get(
      "mcp_skill_display_name",
    );

    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (userPrompt) params.set("user_prompt", userPrompt);
    if (skillId) params.set("skillId", skillId);
    if (externalMcpSkillId)
      params.set("externalMcpSkillId", externalMcpSkillId);
    if (externalMcpServerId)
      params.set("externalMcpServerId", externalMcpServerId);
    if (externalMcpSkillUri)
      params.set("externalMcpSkillUri", externalMcpSkillUri);
    if (externalMcpSkillName)
      params.set("externalMcpSkillName", externalMcpSkillName);
    if (externalMcpServerName)
      params.set("externalMcpServerName", externalMcpServerName);
    if (externalMcpSkillDisplayName)
      params.set("externalMcpSkillDisplayName", externalMcpSkillDisplayName);
    for (const key of REVIEW_PARAM_KEYS) {
      const value = searchParams.get(key);
      if (value) params.set(key, value);
    }

    const queryString = params.toString();
    router.replace(queryString ? `/chat?${queryString}` : "/chat");
  }, [searchParams, router]);

  return null;
}
