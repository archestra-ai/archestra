"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * MCP App 渲染配置
 */
export interface McpAppRenderConfig {
  type: "mcp-app";
  resourceUri: string;
  sandboxUrl: string;
  csp?: Record<string, string>;
  permissions?: string[];
}

/**
 * MCP App 资源
 */
export interface McpAppResource {
  type: "resource";
  resource: {
    uri: string;
    mimeType: string;
    text?: string;
    blob?: string;
  };
}

/**
 * MCP App 渲染器 Props
 */
export interface McpAppRendererProps {
  /** 资源 URI */
  resourceUri: string;
  /** 工具输入 */
  toolInput?: Record<string, unknown>;
  /** 工具结果 */
  toolResult?: unknown;
  /** Agent ID */
  agentId?: string;
  /** 额外的类名 */
  className?: string;
  /** 沙盒 URL */
  sandboxUrl?: string;
  /** CSP 配置 */
  csp?: Record<string, string>;
  /** 权限列表 */
  permissions?: string[];
  /** 消息回调 */
  onMessage?: (message: unknown) => void;
  /** 链接打开回调 */
  onOpenLink?: (params: { url: string }) => void;
}

/**
 * MCP App 渲染器组件
 * 
 * 在沙盒 iframe 中渲染 MCP App UI
 */
export function McpAppRenderer({
  resourceUri,
  toolInput,
  toolResult,
  agentId,
  className,
  sandboxUrl = "/mcp-app-sandbox.html",
  csp,
  permissions,
  onMessage,
  onOpenLink,
}: McpAppRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resourceContent, setResourceContent] = useState<McpAppResource | null>(
    null,
  );

  // 加载资源内容
  useEffect(() => {
    if (!agentId) return;

    const loadResource = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // 编码 URI
        const encodedUri = btoa(resourceUri)
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=/g, "");

        // 获取资源
        const response = await fetch(
          `/api/mcp-apps/resources/${encodedUri}?agentId=${agentId}`,
        );

        if (!response.ok) {
          throw new Error(`Failed to load resource: ${response.statusText}`);
        }

        const result = await response.json();
        
        if (result.data) {
          setResourceContent({
            type: "resource",
            resource: result.data,
          });
        } else {
          throw new Error("Invalid resource data");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load resource");
        console.error("Failed to load MCP App resource:", err);
      } finally {
        setIsLoading(false);
      }
    };

    loadResource();
  }, [resourceUri, agentId]);

  // 初始化沙盒通信
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !resourceContent) return;

    const handleMessage = (event: MessageEvent) => {
      // 验证消息来源
      if (event.source !== iframe.contentWindow) {
        return;
      }

      const { data } = event;

      // 处理不同类型的消息
      switch (data.type) {
        case "mcp-app-ready":
          // 沙盒已准备好，发送初始数据
          iframe.contentWindow?.postMessage(
            {
              type: "mcp-app-init",
              payload: {
                resourceUri,
                toolInput,
                toolResult,
                resource: resourceContent.resource,
              },
            },
            "*",
          );
          break;

        case "mcp-app-message":
          // 来自 App 的消息
          onMessage?.(data.payload);
          break;

        case "mcp-app-open-link":
          // 打开链接请求
          if (data.payload?.url) {
            onOpenLink?.({ url: data.payload.url });
          }
          break;

        default:
          break;
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [resourceContent, resourceUri, toolInput, toolResult, onMessage, onOpenLink]);

  if (isLoading) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-8 rounded-lg border bg-muted/50 min-h-[200px]",
          className,
        )}
      >
        <div className="flex flex-col items-center gap-2">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <p className="text-sm text-muted-foreground">Loading MCP App...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "flex items-center justify-center p-8 rounded-lg border border-destructive/50 bg-destructive/10 min-h-[200px]",
          className,
        )}
      >
        <div className="text-center">
          <p className="text-sm text-destructive font-medium">Error loading MCP App</p>
          <p className="text-xs text-destructive/80 mt-1">{error}</p>
        </div>
      </div>
    );
  }

  // 构建 CSP 字符串
  const cspString = csp
    ? Object.entries(csp)
        .map(([key, value]) => `${key} ${value}`)
        .join("; ")
    : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";

  // 构建沙盒属性
  const sandboxAttr = [
    "allow-scripts",
    "allow-same-origin",
    ...(permissions?.includes("microphone") ? ["allow-microphone"] : []),
    ...(permissions?.includes("camera") ? ["allow-camera"] : []),
  ].join(" ");

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden bg-background",
        className,
      )}
    >
      <iframe
        ref={iframeRef}
        src={sandboxUrl}
        sandbox={sandboxAttr}
        style={{
          width: "100%",
          minHeight: "300px",
          border: "none",
        }}
        title="MCP App"
        allow={permissions?.join("; ")}
      />
    </div>
  );
}

/**
 * 检查内容是否包含 MCP App 资源
 */
export function isMcpAppResource(content: unknown): content is McpAppResource {
  if (typeof content !== "object" || content === null) {
    return false;
  }

  const obj = content as Record<string, unknown>;

  if (obj.type !== "resource") {
    return false;
  }

  const resource = obj.resource as Record<string, unknown> | undefined;
  if (!resource || typeof resource.uri !== "string") {
    return false;
  }

  return resource.uri.startsWith("ui://");
}

/**
 * 从工具结果中提取 MCP App 资源
 */
export function extractMcpAppResources(
  content: unknown,
): McpAppResource[] {
  if (!Array.isArray(content)) {
    return isMcpAppResource(content) ? [content] : [];
  }

  return content.filter((item): item is McpAppResource =>
    isMcpAppResource(item),
  );
}
