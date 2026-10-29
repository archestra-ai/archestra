"use client";

import { MessageCirclePlus } from "lucide-react";
import type { ButtonProps } from "@/components/ui/button";
import type { OpenAppaLaunchTarget } from "@/lib/openappa-chat-prompts";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** Opens a chat on improving coverage of an MCP server, or one of its tools. */
export function ImproveChatButton({
  target,
  size,
}: {
  target: OpenAppaLaunchTarget;
  size: ButtonProps["size"];
}) {
  return (
    <OpenAppaChatButton
      permissions={{ mcpRegistry: ["read"] }}
      variant="outline"
      size={size}
      // On the button, so a refused one, which drops the link, keeps it.
      aria-label={`Improve in chat: ${target.tool ?? target.name}`}
      promptKey="improveCoverage"
      target={target}
      onClick={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus />
      <span>Improve</span>
    </OpenAppaChatButton>
  );
}
