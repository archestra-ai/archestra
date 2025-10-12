"use client";

import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { GetDualLlmResultByToolCallIdResponses } from "@/lib/clients/api";

type DualLlmResult = NonNullable<GetDualLlmResultByToolCallIdResponses["200"]>;

export function DualLlmConversation({ result }: { result: DualLlmResult }) {
  // Type guard to check if conversations is an array
  const conversations = Array.isArray(result.conversations)
    ? result.conversations
    : [];

  return (
    <div className="mt-6 space-y-4">
      <Collapsible defaultOpen className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold flex items-center gap-2">
            🛡️ Dual LLM Q&A Conversation
            <Badge variant="outline">Security Analysis</Badge>
          </h3>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ChevronDownIcon className="w-4 h-4" />
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="space-y-4">
          <div className="rounded-lg border bg-card p-4 space-y-4">
            <div>
              <h4 className="text-sm font-medium mb-2">Tool Call ID</h4>
              <code className="text-xs bg-muted px-2 py-1 rounded">
                {result.toolCallId}
              </code>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Safe Summary</h4>
              <div className="bg-muted rounded-lg p-3">
                <p className="text-sm">{result.result}</p>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">
                Q&A Rounds (Main Agent ↔ Quarantined Agent)
              </h4>
              <div className="space-y-3">
                {conversations.map((message: unknown, idx: number) => {
                  const msg = message as {
                    role: "user" | "assistant";
                    content: string | unknown;
                  };
                  return (
                    <div
                      key={`${idx}-${msg.role}`}
                      className={`rounded-lg p-3 ${
                        msg.role === "user"
                          ? "bg-blue-50 border-l-4 border-blue-500"
                          : "bg-green-50 border-l-4 border-green-500"
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge
                          variant={
                            msg.role === "user" ? "default" : "secondary"
                          }
                          className="text-xs"
                        >
                          {msg.role === "user"
                            ? "Main Agent"
                            : "Quarantined Agent"}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Round {Math.ceil((idx + 1) / 2)}
                        </span>
                      </div>
                      <div className="text-sm whitespace-pre-wrap font-mono">
                        {typeof msg.content === "string"
                          ? msg.content
                          : JSON.stringify(msg.content, null, 2)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
