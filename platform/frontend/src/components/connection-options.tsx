"use client";

import { DollarSign, Eye, Lock, Network, Server, Shield } from "lucide-react";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";

interface ConnectionOptionsProps {
  agentId?: string;
  activeTab: "proxy" | "mcp";
  onTabChange: (tab: "proxy" | "mcp") => void;
}

export function ConnectionOptions({
  agentId,
  activeTab,
  onTabChange,
}: ConnectionOptionsProps) {
  return (
    <div className="space-y-6">
      {/* Tab Selection with inline features - same as in profiles dialog */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onTabChange("proxy")}
          className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
            activeTab === "proxy"
              ? "bg-blue-500/5 border-2 border-blue-500/30"
              : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Network
              className={`h-4 w-4 ${activeTab === "proxy" ? "text-blue-500" : ""}`}
            />
            <span className="font-medium">LLM Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Lock className="h-2.5 w-2.5 text-blue-600 dark:text-blue-400" />
              <span className="text-[10px]">Security</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <DollarSign className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Cost</span>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onTabChange("mcp")}
          className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
            activeTab === "mcp"
              ? "bg-green-500/5 border-2 border-green-500/30"
              : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Shield
              className={`h-4 w-4 ${activeTab === "mcp" ? "text-green-500" : ""}`}
            />
            <span className="font-medium">MCP Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Server className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Unified MCP</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
          </div>
        </button>
      </div>

      {/* Content */}
      <div className="relative">
        {activeTab === "proxy" ? (
          <div className="animate-in fade-in-0 slide-in-from-left-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              <ProxyConnectionInstructions />
            </div>
          </div>
        ) : (
          <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              {agentId && <McpConnectionInstructions agentId={agentId} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
