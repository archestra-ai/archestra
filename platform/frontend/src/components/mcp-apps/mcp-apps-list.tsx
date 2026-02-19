"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  ExternalLink,
  Loader2,
  RefreshCw,
  Settings,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * MCP App 工具信息
 */
export interface McpAppTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  resourceUri: string;
  permissions?: string[];
  csp?: Record<string, string[]>;
}

/**
 * MCP Apps 列表组件 Props
 */
export interface McpAppsListProps {
  /** Agent ID */
  agentId: string;
  /** 额外的类名 */
  className?: string;
}

/**
 * 获取 MCP Apps 列表
 */
async function fetchMcpApps(agentId: string): Promise<McpAppTool[]> {
  const response = await fetch(`/api/mcp-apps/tools?agentId=${agentId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch MCP Apps: ${response.statusText}`);
  }

  const result = await response.json();
  return result.data || [];
}

/**
 * MCP Apps 列表组件
 * 
 * 显示所有支持 MCP Apps 的工具
 */
export function McpAppsList({ agentId, className }: McpAppsListProps) {
  const {
    data: apps = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["mcp-apps", agentId],
    queryFn: () => fetchMcpApps(agentId),
    enabled: !!agentId,
  });

  if (isLoading) {
    return (
      <Card className={cn("w-full", className)}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AppWindow className="h-5 w-5" />
            MCP Apps
          </CardTitle>
          <CardDescription>Interactive UI components from MCP tools</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={cn("w-full", className)}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AppWindow className="h-5 w-5" />
            MCP Apps
          </CardTitle>
          <CardDescription>Interactive UI components from MCP tools</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 gap-4">
            <p className="text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load MCP Apps"}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (apps.length === 0) {
    return (
      <Card className={cn("w-full", className)}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AppWindow className="h-5 w-5" />
            MCP Apps
          </CardTitle>
          <CardDescription>Interactive UI components from MCP tools</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No MCP Apps available for this agent.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Install MCP servers with UI support to see them here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AppWindow className="h-5 w-5" />
              MCP Apps
              <Badge variant="secondary" className="ml-2">{apps.length}</Badge>
            </CardTitle>
            <CardDescription>
              Interactive UI components from MCP tools
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px]">
          <div className="space-y-3">
            {apps.map((app) => (
              <McpAppCard key={app.name} app={app} />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/**
 * 单个 MCP App 卡片
 */
function McpAppCard({ app }: { app: McpAppTool }) {
  const [showDetails, setShowDetails] = useState(false);

  // 从 resourceUri 提取 server name
  const serverName = app.resourceUri.match(/^ui:\/\/([^\/]+)/)?.[1] || "unknown";
  
  // 提取工具名（去掉 server prefix）
  const toolName = app.name.includes("__")
    ? app.name.split("__").pop() || app.name
    : app.name;

  return (
    <div className="rounded-lg border p-4 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm truncate">{toolName}</h4>
            <Badge variant="outline" className="text-xs shrink-0">
              {serverName}
            </Badge>
          </div>
          {app.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {app.description}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <Dialog open={showDetails} onOpenChange={setShowDetails}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <Settings className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{toolName}</DialogTitle>
                <DialogDescription>
                  MCP App configuration details
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4 mt-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Resource URI
                  </label>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 text-xs bg-muted p-2 rounded break-all">
                      {app.resourceUri}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(app.resourceUri);
                      }}
                    >
                      <ExternalLink className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {app.permissions && app.permissions.length > 0 && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">
                      Permissions
                    </label>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {app.permissions.map((perm) => (
                        <Badge key={perm} variant="secondary" className="text-xs">
                          {perm}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    Input Schema
                  </label>
                  <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-auto max-h-[200px]">
                    {JSON.stringify(app.inputSchema, null, 2)}
                  </pre>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
