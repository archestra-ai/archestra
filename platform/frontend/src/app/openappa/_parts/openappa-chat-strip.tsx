"use client";

import { MessageCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { OpenAppaLaunchPromptKey } from "@/lib/openappa-chat-prompts";
import { OpenAppaChatButton } from "./openappa-chat-button";

const QUESTIONS: { promptKey: OpenAppaLaunchPromptKey; label: string }[] = [
  { promptKey: "currentPolicy", label: "Ask about current policy" },
  { promptKey: "explainGuardrails", label: "Explain OpenAPPA guardrails" },
  { promptKey: "changePolicy", label: "Help me change a policy" },
];

/**
 * One line of ways into the configuration agent: three questions that send
 * themselves, and a plain chat that opens on the agent's suggested prompts.
 */
export function OpenAppaChatStrip() {
  return (
    <Card className="flex-row flex-wrap items-center gap-2 px-3 py-2.5">
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
      <OpenAppaChatButton size="sm" className="ml-auto">
        <MessageCircle />
        <span>Open chat</span>
      </OpenAppaChatButton>
    </Card>
  );
}
