"use client";

import { MessageCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { OPENAPPA_SUGGESTED_LAUNCH_PROMPTS } from "@/lib/openappa-chat-prompts";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** The agent's suggested prompts, as the chat shows them: title as the label. */
const QUESTIONS = Object.entries(OPENAPPA_SUGGESTED_LAUNCH_PROMPTS).map(
  ([promptKey, suggested]) => ({
    promptKey: promptKey as keyof typeof OPENAPPA_SUGGESTED_LAUNCH_PROMPTS,
    label: suggested.summaryTitle,
  }),
);

/**
 * One row of ways into the configuration agent: a plain chat that opens on
 * the agent's suggested prompts, then those same prompts, each sending
 * itself.
 */
export function OpenAppaChatStrip() {
  return (
    <Card className="gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <OpenAppaChatButton size="sm">
          <MessageCircle />
          <span>Chat with the configuration agent</span>
        </OpenAppaChatButton>
        {QUESTIONS.map((question) => (
          <OpenAppaChatButton
            key={question.promptKey}
            size="sm"
            variant="outline"
            className="rounded-full"
            promptKey={question.promptKey}
          >
            <MessageCircle />
            <span>{question.label}</span>
          </OpenAppaChatButton>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Ask what your policy allows, why a call was blocked, or have the policy
        changed for you.
      </p>
    </Card>
  );
}
