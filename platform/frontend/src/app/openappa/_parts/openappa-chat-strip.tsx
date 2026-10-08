"use client";

import { MessageCircle } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { OpenAppaLaunchPromptKey } from "@/lib/openappa-chat-prompts";
import { OpenAppaChatButton } from "./openappa-chat-button";

const QUESTIONS: { promptKey: OpenAppaLaunchPromptKey; label: string }[] = [
  { promptKey: "currentPolicy", label: "Ask about current policy" },
  { promptKey: "explainGuardrails", label: "Explain OpenAPPA guardrails" },
  { promptKey: "changePolicy", label: "Help me change a policy" },
];

/**
 * The ways into the configuration agent: what it is for, a plain chat that
 * opens on the agent's suggested prompts, and three questions that send
 * themselves.
 */
export function OpenAppaChatStrip() {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="flex items-center gap-3 px-4">
        <span className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md [&>svg]:size-4">
          <MessageCircle aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <CardTitle className="text-sm">Configuration agent</CardTitle>
          <CardDescription className="text-xs leading-relaxed">
            Ask what your policy allows, why a call was blocked, or have the
            policy changed for you.
          </CardDescription>
        </div>
        <OpenAppaChatButton size="sm" className="shrink-0">
          <MessageCircle />
          <span>Open chat</span>
        </OpenAppaChatButton>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2 px-4">
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
      </CardContent>
    </Card>
  );
}
