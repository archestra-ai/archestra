"use client";

import { type archestraApiTypes, parseFullToolName } from "@shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { CopyButton } from "@/components/copy-button";
import Divider from "@/components/divider";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
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
      <div className="mb-6">
        <div className="flex items-center gap-4 mb-2">
          <Button variant="ghost" size="icon" asChild>
            <Link href="/logs/mcp-gateway">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-tight">
            MCP Tool Call Details
          </h1>
        </div>
        <p className="text-sm text-muted-foreground ml-14">
          {formatDate({ date: mcpToolCall.createdAt })}
        </p>
      </div>
      <Divider className="my-6" />
      <div>
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Metadata</h2>
          <div className="border border-border rounded-lg p-6 bg-card">
            <div className="grid grid-cols-2 gap-x-12 gap-y-6">
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  MCP Gateway
                </div>
                <div className="font-medium">{agent?.name ?? "Unknown"}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">Method</div>
                <Badge
                  variant={
                    method === "initialize"
                      ? "outline"
                      : method === "tools/list"
                        ? "secondary"
                        : "default"
                  }
                >
                  {method}
                </Badge>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  MCP Server
                </div>
                <div className="font-medium font-mono">
                  {mcpToolCall.mcpServerName}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-2">Status</div>
                <Badge variant={isError ? "destructive" : "default"}>
                  {isError ? "Error" : "Success"}
                </Badge>
              </div>
              {toolCall?.name && (
                <div>
                  <div className="text-sm text-muted-foreground mb-2">
                    Tool Name
                  </div>
                  <div className="font-medium font-mono">
                    {parseFullToolName(toolCall.name).toolName || toolCall.name}
                  </div>
                </div>
              )}
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Timestamp
                </div>
                <div className="font-medium">
                  {formatDate({ date: mcpToolCall.createdAt })}
                </div>
              </div>
              {mcpToolCall.userName && (
                <div>
                  <div className="text-sm text-muted-foreground mb-2">User</div>
                  <div className="font-medium">{mcpToolCall.userName}</div>
                </div>
              )}
              {mcpToolCall.authMethod && (
                <div>
                  <div className="text-sm text-muted-foreground mb-2">
                    Auth Method
                  </div>
                  <Badge variant="secondary">
                    {formatAuthMethod(mcpToolCall.authMethod)}
                  </Badge>
                </div>
              )}
            </div>
          </div>
        </div>

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
                <div className="bg-muted rounded-lg p-4 overflow-auto max-h-[600px] relative">
                  <CopyButton
                    text={JSON.stringify(toolCall.arguments, null, 2)}
                    className="absolute top-2 right-2"
                  />
                  <pre className="text-xs whitespace-pre-wrap break-words">
                    {JSON.stringify(toolCall.arguments, null, 2)}
                  </pre>
                </div>
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
              <div className="bg-muted rounded-lg p-4 overflow-auto max-h-[600px] relative">
                <CopyButton
                  text={JSON.stringify(toolResult, null, 2)}
                  className="absolute top-2 right-2"
                />
                <pre className="text-xs whitespace-pre-wrap break-words">
                  {JSON.stringify(toolResult, null, 2)}
                </pre>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </LoadingWrapper>
  );
}
