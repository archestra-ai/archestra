"use client";

import { MessageCircle } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
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
 * The ways into the configuration agent: on the left what it is for and a
 * plain chat that opens on the agent's suggested prompts, on the right those
 * same prompts, each sending itself.
 */
export function OpenAppaChatStrip() {
  return (
    <Card className="flex-row flex-wrap items-start gap-x-8 gap-y-3 px-4 py-4">
      <div className="flex min-w-64 flex-1 items-start gap-3">
        <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md [&>svg]:size-4">
          <MessageCircle aria-hidden />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle className="text-sm">
            Chat with the configuration agent
          </CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Ask what your policy allows, why a call was blocked, or have the
            policy changed for you.
          </CardDescription>
          <div className="pt-2">
            <OpenAppaChatButton size="sm">
              <MessageCircle />
              <span>Open chat</span>
            </OpenAppaChatButton>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
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
    </Card>
  );
}
