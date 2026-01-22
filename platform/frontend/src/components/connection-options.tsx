"use client";

import {
  Bot,
  DollarSign,
  Eye,
  Lock,
  Network,
  Server,
  Shield,
} from "lucide-react";
import { useState } from "react";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import type { ArchitectureTabType } from "@/components/architecture-diagram/architecture-diagram";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInternalAgents } from "@/lib/agent.query";

interface ConnectionOptionsProps {
  agentId?: string;
  activeTab: ArchitectureTabType;
  onTabChange: (tab: ArchitectureTabType) => void;
}

export function ConnectionOptions({
  agentId,
  activeTab,
  onTabChange,
}: ConnectionOptionsProps) {
  const { data: internalAgents } = useInternalAgents();
  const [selectedA2aAgentId, setSelectedA2aAgentId] = useState<string | null>(
    null,
  );

  // Get effective agent ID (selected or first available)
  const effectiveA2aAgentId =
    selectedA2aAgentId ?? internalAgents?.[0]?.id ?? null;
  const selectedA2aAgent = internalAgents?.find(
    (a) => a.id === effectiveA2aAgentId,
  );

  return (
    <div className="space-y-6">
      {/* Tab Selection with inline features - same as in profiles dialog */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onTabChange("proxy")}
          className="flex-1 min-w-0 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 border-2 hover:bg-muted/50"
          style={
            activeTab === "proxy"
              ? {
                  backgroundColor:
                    "color-mix(in oklch, var(--chart-1) 5%, transparent)",
                  borderColor:
                    "color-mix(in oklch, var(--chart-1) 30%, transparent)",
                }
              : {
                  backgroundColor: "hsl(var(--muted) / 0.3)",
                  borderColor: "rgba(0, 0, 0, 0.08)",
                }
          }
        >
          <div className="flex items-center gap-2">
            <Network
              className="h-4 w-4"
              style={
                activeTab === "proxy" ? { color: "var(--chart-1)" } : undefined
              }
            />
            <span className="font-medium">LLM Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Lock
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-1)" }}
              />
              <span className="text-[10px]">Security</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-5)" }}
              />
              <span className="text-[10px]">Observability</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <DollarSign
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-2)" }}
              />
              <span className="text-[10px]">Cost</span>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onTabChange("mcp")}
          className="flex-1 min-w-0 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 border-2 hover:bg-muted/50"
          style={
            activeTab === "mcp"
              ? {
                  backgroundColor:
                    "color-mix(in oklch, var(--chart-2) 5%, transparent)",
                  borderColor:
                    "color-mix(in oklch, var(--chart-2) 30%, transparent)",
                }
              : {
                  backgroundColor: "hsl(var(--muted) / 0.3)",
                  borderColor: "rgba(0, 0, 0, 0.08)",
                }
          }
        >
          <div className="flex items-center gap-2">
            <Shield
              className="h-4 w-4"
              style={
                activeTab === "mcp" ? { color: "var(--chart-2)" } : undefined
              }
            />
            <span className="font-medium">MCP Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Server
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-2)" }}
              />
              <span className="text-[10px]">Unified MCP</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-5)" }}
              />
              <span className="text-[10px]">Observability</span>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onTabChange("a2a")}
          className="flex-1 min-w-0 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 border-2 hover:bg-muted/50"
          style={
            activeTab === "a2a"
              ? {
                  backgroundColor:
                    "color-mix(in oklch, var(--chart-3) 5%, transparent)",
                  borderColor:
                    "color-mix(in oklch, var(--chart-3) 30%, transparent)",
                }
              : {
                  backgroundColor: "hsl(var(--muted) / 0.3)",
                  borderColor: "rgba(0, 0, 0, 0.08)",
                }
          }
        >
          <div className="flex items-center gap-2">
            <Bot
              className="h-4 w-4"
              style={
                activeTab === "a2a" ? { color: "var(--chart-3)" } : undefined
              }
            />
            <span className="font-medium">A2A Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Bot
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-3)" }}
              />
              <span className="text-[10px]">Agent-to-Agent</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye
                className="h-2.5 w-2.5"
                style={{ color: "var(--chart-5)" }}
              />
              <span className="text-[10px]">Orchestration</span>
            </div>
          </div>
        </button>
      </div>

      {/* Content */}
      <div className="relative">
        {activeTab === "proxy" && (
          <div className="animate-in fade-in-0 slide-in-from-left-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              <ProxyConnectionInstructions />
            </div>
          </div>
        )}
        {activeTab === "mcp" && (
          <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
            <div className="p-4 rounded-lg border bg-card">
              {agentId && <McpConnectionInstructions agentId={agentId} />}
            </div>
          </div>
        )}
        {activeTab === "a2a" && (
          <div className="animate-in fade-in-0 slide-in-from-right-2 duration-300">
            <div className="p-4 rounded-lg border bg-card space-y-6">
              {/* Agent Selector */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Select Agent</Label>
                <Select
                  value={effectiveA2aAgentId ?? ""}
                  onValueChange={setSelectedA2aAgentId}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent">
                      {selectedA2aAgent && (
                        <div className="flex items-center gap-2">
                          <Bot className="h-4 w-4" />
                          <span>{selectedA2aAgent.name}</span>
                        </div>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {internalAgents?.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        <div className="flex items-center gap-2">
                          <Bot className="h-4 w-4" />
                          <span>{agent.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Connection Instructions */}
              {selectedA2aAgent && (
                <A2AConnectionInstructions agent={selectedA2aAgent} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
