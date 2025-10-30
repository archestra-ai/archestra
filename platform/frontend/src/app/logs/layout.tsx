"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export default function LogsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  // Determine active tab
  const isLlmProxyActive =
    pathname === "/logs/llm-proxy" || pathname?.startsWith("/logs/llm-proxy/");
  const isMcpGatewayActive =
    pathname === "/logs/mcp-gateway" ||
    pathname?.startsWith("/logs/mcp-gateway/");

  // If we're at /logs exactly, redirect to /logs/llm-proxy
  if (pathname === "/logs") {
    if (typeof window !== "undefined") {
      window.location.href = "/logs/llm-proxy";
    }
    return null;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
          <h1 className="mb-2 text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            View all logs including LLM proxy interactions and MCP gateway tool
            calls.
          </p>
          <div className="mt-6 flex gap-4 border-b border-border">
            <Link
              href="/logs/llm-proxy"
              className={cn(
                "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
                isLlmProxyActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              LLM Proxy
              {isLlmProxyActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </Link>
            <Link
              href="/logs/mcp-gateway"
              className={cn(
                "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
                isMcpGatewayActive
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              MCP Gateway
              {isMcpGatewayActive && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
              )}
            </Link>
          </div>
        </div>
      </div>

      {children}
    </div>
  );
}
