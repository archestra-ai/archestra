"use client";

import { type archestraApiTypes, parseFullToolName } from "@shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { JsonCodeBlock } from "@/components/json-code-block";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { MetadataCard, MetadataItem } from "@/components/metadata-card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/lib/agent.query";
import { formatAuthMethod, useMcpToolCall } from "@/lib/mcp-tool-call.query";
import { formatDate } from "@/lib/utils";

export function McpToolCallDetailPage({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
  id: string;
}) {
  return (
    <div className="w-full h-full overflow-y-auto">
      <ErrorBoundary>
        <McpToolCallDetail initialData={initialData} id={id} />
      </ErrorBoundary>
    </div>
  );
}

function McpToolCallDetail({
  initialData,
  id,
}: {
  initialData?: {
    mcpToolCall: archestraApiTypes.GetMcpToolCallResponses["200"] | undefined;
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
  id: string;
}) {
  const { data: mcpToolCall, isPending } = useMcpToolCall({
    mcpToolCallId: id,
    initialData: initialData?.mcpToolCall,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  if (isPending) {
    return <LoadingSpinner />;
  }

  if (!mcpToolCall) {
    return (
      <div className="text-muted-foreground p-8">MCP tool call not found</div>
    );
  }

  const agent = agents?.find((a) => a.id === mcpToolCall.agentId);
  const method = mcpToolCall.method || "tools/call";
  const toolCall = mcpToolCall.toolCall as {
    name?: string;
    arguments?: unknown;
  } | null;
  const toolResult = mcpToolCall.toolResult as {
    isError?: boolean;
    error?: string;
    content?: unknown;
  } | null;

  const isError =
    method === "tools/call" &&
    toolResult &&
    typeof toolResult === "object" &&
    "isError" in toolResult &&
    toolResult.isError;

  return (
    <LoadingWrapper isPending={isPending}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/mcp/logs">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to MCP Logs
            </Link>
          </Button>
        </div>

        <MetadataCard
          title="Metadata"
          badges={
            <>
              <Badge
                variant={
                  method === "initialize"
                    ? "outline"
                    : method === "tools/list"
                      ? "secondary"
                      : "default"
                }
                className="text-xs"
              >
                {method}
              </Badge>
              <Badge
                variant={isError ? "destructive" : "default"}
                className="text-xs"
              >
                {isError ? "Error" : "Success"}
              </Badge>
            </>
          }
        >
          <MetadataItem label="MCP Gateway">
            <div className="font-semibold">
              {agent?.name ??
                (mcpToolCall.agentId === null
                  ? "Deleted MCP Gateway"
                  : "Unknown")}
            </div>
          </MetadataItem>
          <MetadataItem label="MCP Server">
            <div className="font-mono">{mcpToolCall.mcpServerName}</div>
          </MetadataItem>
          {toolCall?.name && (
            <MetadataItem label="Tool Name">
              <div className="font-mono">
                {parseFullToolName(toolCall.name).toolName || toolCall.name}
              </div>
            </MetadataItem>
          )}
          <MetadataItem label="Timestamp">
            <div className="font-mono text-xs">
              {formatDate({ date: mcpToolCall.createdAt })}
            </div>
          </MetadataItem>
          {mcpToolCall.userName && (
            <MetadataItem label="User">
              <div>{mcpToolCall.userName}</div>
            </MetadataItem>
          )}
          {mcpToolCall.authMethod && (
            <MetadataItem label="Auth Method">
              <Badge variant="secondary" className="text-xs">
                {formatAuthMethod(mcpToolCall.authMethod)}
              </Badge>
            </MetadataItem>
          )}
        </MetadataCard>

        {toolCall?.arguments !== undefined && (
          <Accordion type="single" collapsible className="mb-4">
            <AccordionItem
              value="arguments"
              className="border rounded-lg !border-b"
            >
              <AccordionTrigger className="px-6 py-4 hover:no-underline">
                <span className="text-base font-semibold">Arguments</span>
              </AccordionTrigger>
              <AccordionContent className="px-6 pb-4">
                <JsonCodeBlock value={toolCall.arguments} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        )}

        <Accordion type="single" collapsible defaultValue="result">
          <AccordionItem value="result" className="border rounded-lg !border-b">
            <AccordionTrigger className="px-6 py-4 hover:no-underline">
              <span className="text-base font-semibold">Result</span>
            </AccordionTrigger>
            <AccordionContent className="px-6 pb-4">
              <JsonCodeBlock value={toolResult} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </LoadingWrapper>
  );
}
