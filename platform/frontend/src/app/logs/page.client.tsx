"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { LoadingSpinner } from "@/components/loading";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAgents } from "@/lib/agent.query";
import type {
  GetAgentsResponses,
  GetInteractionsResponses,
} from "@/lib/clients/api";
import { useInteractions } from "@/lib/interaction.query";
import {
  toolNamesRefusedForInteraction,
  toolNamesUsedForInteraction,
} from "@/lib/interaction.utils";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

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

export default function LogsPage({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <div className="border-b border-border bg-card/30">
        <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
          <h1 className="text-2xl font-semibold tracking-tight mb-2">Logs</h1>
          <p className="text-sm text-muted-foreground">
            View all interactions between your agents and LLMs, including
            requests, responses, and tool invocations.
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-8 py-8">
        <ErrorBoundary>
          <Suspense fallback={<LoadingSpinner />}>
            <LogsTable initialData={initialData} />
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}

function LogsTable({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  const { data: interactions = [] } = useInteractions({
    initialData: initialData?.interactions,
  });
  const { data: agents = [] } = useAgents({
    initialData: initialData?.agents,
  });

  if (!interactions || interactions.length === 0) {
    return <p className="text-muted-foreground">No logs found</p>;
  }

  return (
    <div className="border rounded-lg overflow-x-auto">
      <div className="w-[fit-content]">
        <Table className="overflow-x-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">Date</TableHead>
              <TableHead className="w-[140px]">Agent</TableHead>
              <TableHead className="w-[100px]">Model</TableHead>
              <TableHead className="w-[180px]">User Message</TableHead>
              <TableHead className="w-[180px]">Assistant Response</TableHead>
              <TableHead className="w-[160px]">Tools</TableHead>
              <TableHead className="w-[100px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {interactions.map((interaction) => {
              const agent = agents?.find((a) => a.id === interaction.agentId);
              return (
                <LogRow
                  key={interaction.id}
                  interaction={interaction}
                  agent={agent}
                />
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function LogRow({
  interaction,
  agent,
}: {
  interaction: GetInteractionsResponses["200"][number];
  agent?: GetAgentsResponses["200"][number];
}) {
  const toolsUsed = toolNamesUsedForInteraction(interaction);
  const toolsBlocked = toolNamesRefusedForInteraction(interaction);

  const userMessage = findLastUserMessage(interaction);
  const assistantResponse =
    interaction.response.choices[0]?.message?.content ?? "";

  const formattedDate = formatDate({ date: interaction.createdAt });
  const agentName = agent?.name ?? "Unknown";
  const modelName = interaction.request.model;

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{formattedDate}</TableCell>
      <TableCell>
        <TruncatedText message={agentName} maxLength={30} />
      </TableCell>
      <TableCell>
        <Badge variant="secondary" className="text-xs">
          {modelName}
        </Badge>
      </TableCell>
      <TableCell className="text-xs">
        <TruncatedText message={userMessage} maxLength={80} />
      </TableCell>
      <TableCell className="text-xs">
        <TruncatedText message={assistantResponse} maxLength={80} />
      </TableCell>
      <TableCell>
        {toolsUsed.length > 0 || toolsBlocked.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {toolsUsed.map((toolName) => (
              <Badge
                key={`used-${toolName}`}
                variant="default"
                className="text-xs whitespace-nowrap"
              >
                ✓ {toolName}
              </Badge>
            ))}
            {toolsBlocked.map((toolName) => (
              <Badge
                key={`blocked-${toolName}`}
                variant="destructive"
                className="text-xs whitespace-nowrap"
              >
                ✗ {toolName}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">None</span>
        )}
      </TableCell>
      <TableCell>
        <Link
          href={`/logs/${interaction.id}`}
          className="flex items-center gap-1 text-sm text-primary hover:underline whitespace-nowrap"
        >
          View
          <ChevronRightIcon className="w-3 h-3" />
        </Link>
      </TableCell>
    </TableRow>
  );
}
