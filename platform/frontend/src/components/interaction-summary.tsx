"use client";

import {
  BrainIcon,
  CalendarDaysIcon,
  HatGlassesIcon,
  MessageSquareMoreIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactElement, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import type {
  GetAgentsResponses,
  GetInteractionsResponses,
} from "@/lib/clients/api";
import { useDualLlmResultByToolCallId } from "@/lib/dual-llm-result.query";
import {
  getLastToolCallId,
  isLastMessageToolCall,
  toolNamesRefusedForInteraction,
  toolNamesUsedForInteraction,
} from "@/lib/interaction.utils";
import { formatDate } from "@/lib/utils";

export function InteractionSummary({
  interaction,
  agent,
}: {
  interaction: GetInteractionsResponses["200"][number];
  agent?: GetAgentsResponses["200"][number];
}) {
  const [agentNameTruncated, _setAgentNameTruncated] = useState(false);
  const [lastMessageTruncated, _setLastMessageTruncated] = useState(false);

  // Check if this interaction is about a tool call
  const lastToolCallId = getLastToolCallId(interaction);
  const isDualLlmRelevant = isLastMessageToolCall(interaction);

  // Fetch dual LLM result if relevant
  const { data: dualLlmResult } = useDualLlmResultByToolCallId(lastToolCallId);

  const iconClassName = "w-4 h-4";
  return (
    <div className="pr-12 min-w-0">
      <div className="flex justify-between w-full gap-4 min-w-0">
        <RawLogDetail
          label="Date"
          value={formatDate({ date: interaction.createdAt })}
          icon={<CalendarDaysIcon className={iconClassName} />}
        />
        <RawLogDetail
          label="Model"
          value={interaction.request.model}
          icon={<BrainIcon className={iconClassName} />}
        />
        <RawLogDetail
          label="Tools used"
          value={
            <div>
              {toolNamesUsedForInteraction(interaction).length > 0 ? (
                toolNamesUsedForInteraction(interaction).map((toolName) => (
                  <Badge key={toolName} className="mt-2 mr-2">
                    {toolName}
                  </Badge>
                ))
              ) : (
                <p className="text-muted-foreground">None</p>
              )}
            </div>
          }
          icon={<WrenchIcon className={iconClassName} />}
        />
        <RawLogDetail
          label="Tools blocked"
          value={
            <div>
              {toolNamesRefusedForInteraction(interaction).length > 0 ? (
                toolNamesRefusedForInteraction(interaction).map((toolName) => (
                  <Badge key={toolName} className="mt-2" variant="destructive">
                    {toolName}
                  </Badge>
                ))
              ) : (
                <p className="text-muted-foreground">None</p>
              )}
            </div>
          }
          icon={<WrenchIcon className={iconClassName} />}
        />
        {isDualLlmRelevant && (
          <RawLogDetail
            label="Dual LLM Analysis"
            value={
              dualLlmResult ? (
                <Badge variant="default" className="mt-2 bg-green-600">
                  🛡️ Analyzed
                </Badge>
              ) : (
                <p className="text-muted-foreground">Not analyzed</p>
              )
            }
            icon={<ShieldCheckIcon className={iconClassName} />}
          />
        )}
      </div>
      <div className="flex justify-between w-full gap-4 mt-4 min-w-0">
        <RawLogDetail
          label="Agent name"
          value={<TruncatedText message={agent?.name ?? "Unknown"} />}
          icon={<HatGlassesIcon className={iconClassName} />}
          isTruncated={agentNameTruncated}
        />
        <RawLogDetail
          label="Last user message"
          value={<TruncatedText message={findLastUserMessage(interaction)} />}
          icon={<MessageSquareMoreIcon className={iconClassName} />}
          isTruncated={lastMessageTruncated}
        />
        <RawLogDetail
          label="Response"
          value={
            <TruncatedText
              message={interaction.response.choices[0].message.content ?? ""}
            />
          }
          icon={<MessageSquareMoreIcon className={iconClassName} />}
          isTruncated={lastMessageTruncated}
        />
      </div>
    </div>
  );
}

function findLastUserMessage(
  interaction: GetInteractionsResponses["200"][number],
): string {
  const reversedMessages = [...interaction.request.messages].reverse();
  for (const message of reversedMessages) {
    if (message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (message.content?.[0]?.type === "text") {
      return message.content[0].text;
    }
  }
  return "";
}

function RawLogDetail({
  label,
  value,
  icon,
  width,
  isTruncated,
}: {
  label: string;
  value: string | ReactElement;
  icon: ReactElement;
  width?: string;
  isTruncated?: boolean;
}) {
  return (
    <div style={{ width }} className="min-w-0 relative group/detail flex-1">
      <span className="flex text-sm text-muted-foreground mb-2 items-center">
        <span className="mr-1">{icon}</span> {label}
      </span>
      {typeof value === "string" ? (
        <Badge
          variant="secondary"
          className={`flex min-w-0 max-w-full justify-start ${
            isTruncated ? "pr-0" : ""
          } whitespace-normal`}
        >
          {value}
        </Badge>
      ) : (
        value
      )}
    </div>
  );
}
