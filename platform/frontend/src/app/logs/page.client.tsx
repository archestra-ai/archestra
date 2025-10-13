"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
    <div className="container mx-auto overflow-y-auto">
      <div className="w-full h-full">
        <div className="border-b border-border bg-card/30">
          <div className="max-w-7xl mx-auto px-8 py-8">
            <h1 className="text-2xl font-semibold tracking-tight mb-2">Logs</h1>
            <p className="text-sm text-muted-foreground">
              View all interactions between your agents and LLMs, including
              requests, responses, and tool invocations.
            </p>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-8 py-8">
          <ErrorBoundary>
            <Suspense fallback={<LoadingSpinner />}>
              <LogsTable initialData={initialData} />
            </Suspense>
          </ErrorBoundary>
        </div>
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
    <div className="border rounded-lg">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[140px]">Date</TableHead>
            <TableHead className="w-[150px]">Agent</TableHead>
            <TableHead className="w-[120px]">Model</TableHead>
            <TableHead className="w-[200px]">User Message</TableHead>
            <TableHead className="w-[200px]">Assistant Response</TableHead>
            <TableHead className="w-[180px]">Tools</TableHead>
            <TableHead className="w-[80px]">Actions</TableHead>
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
      <TableCell className="font-mono text-xs">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">{formattedDate}</div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{formattedDate}</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="truncate cursor-default">{agentName}</div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{agentName}</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              <Badge variant="secondary" className="text-xs">
                {modelName}
              </Badge>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{modelName}</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="max-w-[200px] text-xs truncate cursor-default">
              {userMessage || (
                <span className="text-muted-foreground">No message</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-md">
            <p className="whitespace-pre-wrap break-words">
              {userMessage || "No message"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="max-w-[200px] text-xs truncate cursor-default">
              {assistantResponse || (
                <span className="text-muted-foreground">No response</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent className="max-w-md">
            <p className="whitespace-pre-wrap break-words">
              {assistantResponse || "No response"}
            </p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="cursor-default">
              {toolsUsed.length > 0 || toolsBlocked.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {toolsUsed.map((toolName) => (
                    <Badge
                      key={`used-${toolName}`}
                      variant="default"
                      className="text-xs"
                    >
                      ✓ {toolName}
                    </Badge>
                  ))}
                  {toolsBlocked.map((toolName) => (
                    <Badge
                      key={`blocked-${toolName}`}
                      variant="destructive"
                      className="text-xs"
                    >
                      ✗ {toolName}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-muted-foreground text-xs">None</span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {toolsUsed.length > 0 || toolsBlocked.length > 0 ? (
              <div className="space-y-1">
                {toolsUsed.length > 0 && (
                  <div>
                    <p className="font-semibold mb-1">Used:</p>
                    <ul className="list-disc list-inside">
                      {toolsUsed.map((toolName) => (
                        <li key={`used-${toolName}`}>{toolName}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {toolsBlocked.length > 0 && (
                  <div>
                    <p className="font-semibold mb-1">Blocked:</p>
                    <ul className="list-disc list-inside">
                      {toolsBlocked.map((toolName) => (
                        <li key={`blocked-${toolName}`}>{toolName}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p>No tools used</p>
            )}
          </TooltipContent>
        </Tooltip>
      </TableCell>
      <TableCell>
        <Link
          href={`/logs/${interaction.id}`}
          className="flex items-center gap-1 text-sm text-primary hover:underline"
        >
          View
          <ChevronRightIcon className="w-3 h-3" />
        </Link>
      </TableCell>
    </TableRow>
  );
}
