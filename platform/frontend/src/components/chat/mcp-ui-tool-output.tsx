"use client";

import type {
  CallToolResult,
  ContentBlock,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AppRenderer,
  UIResourceRenderer,
  type UIActionResult,
} from "@mcp-ui/client";
import { useCallback, useMemo } from "react";
import { useChatSession } from "@/contexts/global-chat-context";
import { getBackendBaseUrl } from "@/lib/config";
import { callMcpUiTool, readMcpUiResource } from "@/lib/mcp-ui.query";

type McpTextBlock = Extract<ContentBlock, { type: "text" }>;
type McpImageBlock = Extract<ContentBlock, { type: "image" }>;
type McpResourceBlock = Extract<ContentBlock, { type: "resource" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMcpTextBlock(block: unknown): block is McpTextBlock {
  return (
    isRecord(block) &&
    block.type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
}

function isMcpImageBlock(block: unknown): block is McpImageBlock {
  return (
    isRecord(block) &&
    block.type === "image" &&
    typeof (block as Record<string, unknown>).data === "string" &&
    typeof (block as Record<string, unknown>).mimeType === "string"
  );
}

function isMcpResourceBlock(block: unknown): block is McpResourceBlock {
  if (!isRecord(block)) return false;
  if (block.type !== "resource") return false;
  if (!isRecord(block.resource)) return false;
  return typeof block.resource.uri === "string";
}

function toToolResultContent(output: unknown): ContentBlock[] {
  // Some tool implementations may return a CallToolResult-like object.
  if (isRecord(output) && Array.isArray(output.content)) {
    return toToolResultContent(output.content);
  }

  if (Array.isArray(output)) {
    const blocks: ContentBlock[] = [];

    for (const item of output) {
      if (isMcpTextBlock(item)) {
        blocks.push(item as unknown as ContentBlock);
        continue;
      }

      if (isRecord(item) && item.type === "image" && typeof item.data === "string") {
        const mimeType =
          typeof item.mimeType === "string" && item.mimeType.length > 0
            ? item.mimeType
            : "image/png";
        blocks.push({ ...item, mimeType } as unknown as ContentBlock);
        continue;
      }

      if (isMcpResourceBlock(item)) {
        blocks.push(item as unknown as ContentBlock);
        continue;
      }

      // Preserve any other MCP content block types (audio, resource_link, etc.).
      if (isRecord(item) && typeof item.type === "string") {
        blocks.push(item as unknown as ContentBlock);
        continue;
      }

      if (typeof item === "string") {
        blocks.push({ type: "text", text: item } as unknown as ContentBlock);
        continue;
      }

      if (item == null) {
        continue;
      }

      blocks.push({
        type: "text",
        text: JSON.stringify(item),
      } as unknown as ContentBlock);
    }

    return blocks;
  }

  if (typeof output === "string") {
    return [{ type: "text", text: output }];
  }

  if (output == null) {
    return [];
  }

  return [{ type: "text", text: JSON.stringify(output) }];
}

export function McpUiToolOutput({
  agentId,
  conversationId,
  toolName,
  toolInput,
  toolOutput,
  toolResourceUri,
}: {
  agentId: string | undefined;
  conversationId: string | undefined;
  toolName: string;
  toolInput: Record<string, unknown> | undefined;
  toolOutput: unknown;
  toolResourceUri: string | undefined;
}) {
  const chatSession = useChatSession(conversationId);

  const backendBaseUrl = getBackendBaseUrl();
  const legacyProxyUrl = useMemo(() => {
    try {
      return new URL("/mcp-ui-proxy", backendBaseUrl).toString();
    } catch {
      return undefined;
    }
  }, [backendBaseUrl]);

  const sandboxUrl = useMemo(() => {
    try {
      return new URL("/sandbox_proxy.html", backendBaseUrl);
    } catch {
      return null;
    }
  }, [backendBaseUrl]);

  const contentBlocks = useMemo(() => toToolResultContent(toolOutput), [toolOutput]);

  const textBlocks = useMemo(
    () => contentBlocks.filter(isMcpTextBlock),
    [contentBlocks],
  );

  const imageBlocks = useMemo(
    () => contentBlocks.filter(isMcpImageBlock),
    [contentBlocks],
  );

  const resourceBlocks = useMemo(
    () => contentBlocks.filter(isMcpResourceBlock),
    [contentBlocks],
  );

  const onSendPromptToChat = useCallback(
    (prompt: string) => {
      if (!chatSession?.sendMessage) {
        return false;
      }

      chatSession.sendMessage({
        role: "user",
        parts: [{ type: "text", text: prompt }],
      });
      return true;
    },
    [chatSession],
  );

  const onLegacyUiAction = useCallback(
    async (action: UIActionResult) => {
      switch (action.type) {
        case "link": {
          window.open(action.payload.url, "_blank", "noopener,noreferrer");
          return { status: "success" };
        }

        case "prompt": {
          const ok = onSendPromptToChat(action.payload.prompt);
          return ok
            ? { status: "success" }
            : { status: "error", message: "No active chat session" };
        }

        case "tool": {
          if (!agentId) {
            return { status: "error", message: "Missing agentId" };
          }

          const result = await callMcpUiTool({
            agentId,
            name: action.payload.toolName,
            // biome-ignore lint/suspicious/noExplicitAny: UI tool params are dynamic
            arguments: action.payload.params as any,
            conversationId,
          });

          return result;
        }

        case "notify": {
          // Intentionally minimal: surface it in the console for now.
          // Host UIs can optionally show a toast/snackbar.
          // biome-ignore lint/suspicious/noConsole: notify is informational
          console.info("[mcp-ui notify]", action.payload.message);
          return { status: "success" };
        }

        case "intent": {
          // Intents aren't first-class in Archestra chat UI yet.
          // Treat them as prompts for now.
          const ok = onSendPromptToChat(
            `${action.payload.intent} ${JSON.stringify(action.payload.params ?? {})}`,
          );
          return ok
            ? { status: "success" }
            : { status: "error", message: "No active chat session" };
        }

        default:
          return { status: "error", message: "Unsupported action" };
      }
    },
    [agentId, conversationId, onSendPromptToChat],
  );

  const showAnyUi =
    Boolean(toolResourceUri) ||
    resourceBlocks.length > 0 ||
    imageBlocks.length > 0;

  if (!showAnyUi) {
    return null;
  }

  return (
    <div className="space-y-4 p-4">
      {toolResourceUri && sandboxUrl ? (
        <div className="space-y-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            UI
          </h4>
          <div className="rounded-md bg-muted/50 p-2">
            <AppRenderer
              toolName={toolName}
              toolResourceUri={toolResourceUri}
              sandbox={{ url: sandboxUrl }}
              toolInput={toolInput}
              toolResult={{
                content: contentBlocks,
                isError: false,
              }}
              onOpenLink={async ({ url }) => {
                window.open(url, "_blank", "noopener,noreferrer");
                return { isError: false };
              }}
              onMessage={async ({ content }) => {
                const text = Array.isArray(content)
                  ? (content.find((b) => isMcpTextBlock(b)) as McpTextBlock | undefined)
                      ?.text
                  : undefined;

                if (text) {
                  onSendPromptToChat(text);
                }

                return { isError: false };
              }}
              onCallTool={async ({ name, arguments: args }) => {
                if (!agentId) {
                  return {
                    content: [{ type: "text", text: "Missing agentId" }],
                    isError: true,
                  };
                }

                const result = await callMcpUiTool({
                  agentId,
                  name,
                  // biome-ignore lint/suspicious/noExplicitAny: Tool args are dynamic
                  arguments: (args ?? {}) as any,
                  conversationId,
                });

                return {
                  content: result.content,
                  isError: result.isError ?? false,
                };
              }}
              onReadResource={async ({ uri }) => {
                if (!agentId) {
                  return { contents: [] };
                }
                return await readMcpUiResource({ agentId, uri });
              }}
              onListResources={async () => ({ resources: [] })}
              onListResourceTemplates={async () => ({ resourceTemplates: [] })}
              onListPrompts={async () => ({ prompts: [] })}
              onError={(error) => {
                // biome-ignore lint/suspicious/noConsole: UI error should be visible during development
                console.error("[mcp-ui AppRenderer]", error);
              }}
            />
          </div>
        </div>
      ) : null}

      {resourceBlocks.length > 0 ? (
        <div className="space-y-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Embedded UI
          </h4>
          <div className="space-y-3">
            {resourceBlocks.map((block) => (
              <div key={block.resource.uri} className="rounded-md bg-muted/50 p-2">
                <UIResourceRenderer
                  resource={block.resource}
                  onUIAction={onLegacyUiAction}
                  htmlProps={{
                    proxy: legacyProxyUrl,
                    autoResizeIframe: true,
                    style: { width: "100%", height: 600 },
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {imageBlocks.length > 0 ? (
        <div className="space-y-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Images
          </h4>
          <div className="space-y-3">
            {imageBlocks.map((img, idx) => {
              const mimeType = img.mimeType ?? "image/png";
              return (
                <img
                  // biome-ignore lint/suspicious/noArrayIndexKey: Stable ordering from MCP output
                  key={`${mimeType}-${idx}`}
                  src={`data:${mimeType};base64,${img.data}`}
                  alt="Tool output"
                  className="max-w-full rounded border"
                />
              );
            })}
          </div>
        </div>
      ) : null}

      {/* If the tool output is only UI blocks, keep the text blocks visible too */}
      {textBlocks.length > 0 && resourceBlocks.length > 0 ? (
        <div className="text-xs whitespace-pre-wrap text-muted-foreground">
          {textBlocks.map((b) => b.text).join("\n")}
        </div>
      ) : null}
    </div>
  );
}
