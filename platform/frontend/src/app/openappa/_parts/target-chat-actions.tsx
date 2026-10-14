"use client";

import { MessageCircleQuestion } from "lucide-react";
import type { ButtonProps } from "@/components/ui/button";
import type { OpenAppaLaunchTarget } from "@/lib/openappa-chat-prompts";
import { ImproveChatButton } from "./improve-chat-button";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** Explain and Improve for one MCP server, each opening a chat scoped to it. */
export function TargetChatActions({
  target,
  size,
}: {
  target: OpenAppaLaunchTarget;
  size: ButtonProps["size"];
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <OpenAppaChatButton
        permissions={{ mcpRegistry: ["read"] }}
        variant="ghost"
        size={size}
        // On the button, so a refused one, which drops the link, keeps it.
        aria-label={`Explain in chat: ${target.name}`}
        promptKey="explainPolicy"
        target={target}
        onClick={(event) => event.stopPropagation()}
      >
        <MessageCircleQuestion />
        <span>Explain</span>
      </OpenAppaChatButton>
      <ImproveChatButton target={target} size={size} />
    </div>
  );
}
