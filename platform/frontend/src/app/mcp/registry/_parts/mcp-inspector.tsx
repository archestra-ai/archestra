"use client";

import { archestraApiSdk } from "@shared";
import { ChevronDown, Loader2, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<
      string,
      {
        type?: string;
        description?: string;
        enum?: string[];
        default?: unknown;
      }
    >;
    required?: string[];
  };
}

interface RequestLogEntry {
  id: number;
  timestamp: string;
  request: { method: string; body: Record<string, unknown> };
  response: unknown;
  error?: string;
  durationMs: number;
}

interface McpInspectorProps {
  serverId: string;
  isActive: boolean;
}

export function McpInspector({ serverId, isActive }: McpInspectorProps) {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [isCallingTool, setIsCallingTool] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [requestLog, setRequestLog] = useState<RequestLogEntry[]>([]);
  const logIdRef = useRef(0);

  const addLogEntry = useCallback(
    (
      requestBody: Record<string, unknown>,
      response: unknown,
      error: string | undefined,
      durationMs: number,
    ) => {
      logIdRef.current += 1;
      const entry: RequestLogEntry = {
        id: logIdRef.current,
        timestamp: new Date().toISOString(),
        request: { method: "POST", body: requestBody },
        response,
        error,
        durationMs,
      };
      setRequestLog((prev) => [entry, ...prev]);
    },
    [],
  );

  const loadTools = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    const body = { method: "tools/list" as const };
    const start = performance.now();
    try {
      const { data, error } = await archestraApiSdk.inspectMcpServer({
        path: { id: serverId },
        body,
      });
      const durationMs = Math.round(performance.now() - start);
      if (error) {
        const msg =
          (error as { error?: { message?: string } })?.error?.message ??
          "Failed to load tools";
        addLogEntry(body, error, msg, durationMs);
        setLoadError(msg);
        return;
      }
      addLogEntry(body, data, undefined, durationMs);
      const result = data as { tools?: McpTool[] };
      const toolsList = result?.tools ?? [];
      setTools(toolsList);
      if (toolsList.length > 0) {
        setSelectedTool((prev) => {
          if (prev && toolsList.some((t) => t.name === prev.name)) return prev;
          return toolsList[0];
        });
      }
    } catch {
      const durationMs = Math.round(performance.now() - start);
      addLogEntry(body, null, "Failed to connect to MCP server", durationMs);
      setLoadError("Failed to connect to MCP server");
    } finally {
      setIsLoading(false);
    }
  }, [serverId, addLogEntry]);

  useEffect(() => {
    if (isActive && serverId) {
      setTools([]);
      setSelectedTool(null);
      setParamValues({});
      setRequestLog([]);
      logIdRef.current = 0;
      loadTools();
    }
  }, [isActive, serverId, loadTools]);

  const handleSelectTool = useCallback((tool: McpTool) => {
    setSelectedTool(tool);
    setParamValues({});
    setShowSchema(false);
  }, []);

  const handleCallTool = useCallback(async () => {
    if (!selectedTool) return;
    setIsCallingTool(true);

    // Build arguments, parsing JSON values where needed
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(paramValues)) {
      if (value === "") continue;
      try {
        args[key] = JSON.parse(value);
      } catch {
        args[key] = value;
      }
    }

    const body = {
      method: "tools/call" as const,
      toolName: selectedTool.name,
      toolArguments: args,
    };
    const start = performance.now();
    try {
      const { data, error } = await archestraApiSdk.inspectMcpServer({
        path: { id: serverId },
        body,
      });
      const durationMs = Math.round(performance.now() - start);
      if (error) {
        const msg =
          (error as { error?: { message?: string } })?.error?.message ??
          "Tool call failed";
        addLogEntry(body, error, msg, durationMs);
        return;
      }
      addLogEntry(body, data, undefined, durationMs);
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const msg = err instanceof Error ? err.message : "Unknown error";
      toast.error("Tool call failed");
      addLogEntry(body, null, msg, durationMs);
    } finally {
      setIsCallingTool(false);
    }
  }, [selectedTool, paramValues, serverId, addLogEntry]);

  // Get the latest tool call response for the selected tool (for inline display)
  const latestToolCallResponse = requestLog.find(
    (e) =>
      e.request.body.method === "tools/call" &&
      e.request.body.toolName === selectedTool?.name,
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center flex-1 min-h-0">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Connecting to MCP server...</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 gap-3">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={loadTools}>
          Retry
        </Button>
      </div>
    );
  }

  const properties = selectedTool?.inputSchema?.properties ?? {};
  const requiredParams = selectedTool?.inputSchema?.required ?? [];

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex items-center gap-2 flex-shrink-0">
        <Badge variant="secondary">{tools.length} tools</Badge>
        <Button variant="outline" size="sm" onClick={loadTools}>
          List Tools
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 rounded-lg border overflow-hidden">
        {/* Tool list sidebar */}
        <ScrollArea className="w-64 flex-shrink-0 border-r">
          <div className="p-2">
            {tools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                onClick={() => handleSelectTool(tool)}
                className={cn(
                  "w-full text-left px-3 py-2.5 rounded-md transition-colors",
                  selectedTool?.name === tool.name
                    ? "bg-primary/10 border-l-2 border-primary"
                    : "hover:bg-muted/50",
                )}
              >
                <div className="text-sm font-medium truncate">{tool.name}</div>
                {tool.description && (
                  <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {tool.description}
                  </div>
                )}
              </button>
            ))}
            {tools.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No tools found
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Tool details + request log */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <ScrollArea className="flex-1 min-h-0">
            {selectedTool ? (
              <div className="p-4 space-y-5">
                <div>
                  <h3 className="text-lg font-semibold">{selectedTool.name}</h3>
                  {selectedTool.description && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {selectedTool.description}
                    </p>
                  )}
                </div>

                {/* Parameters */}
                {Object.keys(properties).length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold">Parameters</h4>
                    {Object.entries(properties).map(([name, prop]) => {
                      const isRequired = requiredParams.includes(name);
                      return (
                        <div key={name} className="space-y-1.5">
                          <Label className="text-sm">
                            {name}
                            {isRequired && (
                              <span className="text-destructive ml-0.5">*</span>
                            )}
                            {prop.type && (
                              <span className="text-muted-foreground font-normal ml-1.5">
                                {prop.type}
                              </span>
                            )}
                          </Label>
                          <Input
                            placeholder={prop.description || `Enter ${name}`}
                            value={paramValues[name] ?? ""}
                            onChange={(e) =>
                              setParamValues((prev) => ({
                                ...prev,
                                [name]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Call button */}
                <Button
                  onClick={handleCallTool}
                  disabled={isCallingTool}
                  className="gap-2"
                >
                  {isCallingTool ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Call Tool
                </Button>

                {/* Latest response for this tool */}
                {latestToolCallResponse && (
                  <div className="space-y-2">
                    <h4 className="text-sm font-semibold">Response</h4>
                    <div className="rounded-md bg-slate-950 p-4 overflow-auto">
                      <pre className="text-emerald-400 font-mono text-xs whitespace-pre-wrap">
                        {JSON.stringify(
                          latestToolCallResponse.error
                            ? { error: latestToolCallResponse.error }
                            : latestToolCallResponse.response,
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  </div>
                )}

                {/* JSON Schema toggle */}
                {selectedTool.inputSchema && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowSchema((v) => !v)}
                      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 transition-transform",
                          !showSchema && "-rotate-90",
                        )}
                      />
                      View JSON Schema
                    </button>
                    {showSchema && (
                      <div className="rounded-md bg-slate-950 p-4 mt-2 overflow-auto">
                        <pre className="text-slate-400 font-mono text-xs whitespace-pre-wrap">
                          {JSON.stringify(selectedTool.inputSchema, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-8">
                Select a tool to inspect
              </div>
            )}
          </ScrollArea>

          {/* Request/Response log */}
          {requestLog.length > 0 && (
            <div className="border-t flex-shrink-0 max-h-[40%] flex flex-col min-h-0">
              <div className="px-4 py-2 text-xs font-semibold text-muted-foreground bg-muted/30 flex-shrink-0">
                Request Log
              </div>
              <ScrollArea className="flex-1 min-h-0">
                <div className="divide-y">
                  {requestLog.map((entry) => (
                    <RequestLogItem key={entry.id} entry={entry} />
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestLogItem({ entry }: { entry: RequestLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const isError = !!entry.error;
  const method = entry.request.body.method as string;
  const toolName = entry.request.body.toolName as string | undefined;

  return (
    <div className="text-xs font-mono">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-2 hover:bg-muted/30 flex items-center gap-2"
      >
        <ChevronDown
          className={cn(
            "h-3 w-3 flex-shrink-0 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <span
          className={cn(
            "font-semibold",
            isError ? "text-destructive" : "text-emerald-600",
          )}
        >
          {method}
        </span>
        {toolName && (
          <span className="text-muted-foreground truncate">{toolName}</span>
        )}
        <span className="ml-auto text-muted-foreground flex-shrink-0">
          {entry.durationMs}ms
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <div>
            <div className="text-muted-foreground mb-1">Request</div>
            <div className="rounded bg-slate-950 p-2 overflow-auto">
              <pre className="text-slate-300 whitespace-pre-wrap">
                {JSON.stringify(entry.request.body, null, 2)}
              </pre>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground mb-1">Response</div>
            <div className="rounded bg-slate-950 p-2 overflow-auto">
              <pre
                className={cn(
                  "whitespace-pre-wrap",
                  isError ? "text-red-400" : "text-emerald-400",
                )}
              >
                {entry.error
                  ? entry.error
                  : JSON.stringify(entry.response, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
