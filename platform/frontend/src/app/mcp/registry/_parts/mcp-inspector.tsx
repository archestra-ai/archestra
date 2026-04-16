"use client";

import { archestraApiSdk } from "@shared";
import { ChevronDown, CircuitBoard, Loader2, Play, Zap } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
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
  const [logPanelRatio, setLogPanelRatio] = useState(0.4);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const startY = e.clientY;
      const startRatio = logPanelRatio;
      const containerHeight = container.getBoundingClientRect().height;

      const onMove = (ev: globalThis.PointerEvent) => {
        const delta = startY - ev.clientY;
        const newRatio = Math.min(
          0.8,
          Math.max(0.15, startRatio + delta / containerHeight),
        );
        setLogPanelRatio(newRatio);
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [logPanelRatio],
  );

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
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="relative flex items-center justify-center">
            <span className="absolute inline-flex h-8 w-8 rounded-full bg-emerald-500/20 animate-ping" />
            <Loader2 className="h-5 w-5 animate-spin text-emerald-500" />
          </div>
          <span className="font-mono text-[11px] tracking-[0.08em]">
            establishing link
          </span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 min-h-0 gap-4">
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
          <span className="text-destructive tracking-[0.08em]">
            connection failed
          </span>
        </div>
        <p className="text-sm text-muted-foreground max-w-sm text-center">
          {loadError}
        </p>
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
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-muted-foreground">
          <CircuitBoard className="h-3.5 w-3.5" />
          <span>Tools</span>
          <span className="text-foreground font-semibold tabular-nums">
            {tools.length.toString().padStart(2, "0")}
          </span>
        </div>
        <div className="h-3 w-px bg-border" />
        <Button
          variant="outline"
          size="sm"
          onClick={loadTools}
          className="h-7 px-2.5 text-xs gap-1.5"
        >
          <Zap className="h-3 w-3" />
          List Tools
        </Button>
      </div>

      <div className="flex flex-1 min-h-0 rounded-md border bg-background overflow-hidden">
        {/* Tool list sidebar */}
        <div className="w-72 flex-shrink-0 border-r flex flex-col min-h-0 bg-muted/20">
          <div className="px-3 py-2 border-b bg-muted/30 flex items-center justify-between flex-shrink-0">
            <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
              Tools
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {tools.length}
            </span>
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-1.5 space-y-0.5">
              {tools.map((tool) => {
                const isSelected = selectedTool?.name === tool.name;
                return (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => handleSelectTool(tool)}
                    className={cn(
                      "group relative w-full text-left px-3 py-2 rounded-sm transition-all duration-150",
                      isSelected
                        ? "bg-background shadow-sm"
                        : "hover:bg-background/60",
                    )}
                  >
                    {isSelected && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-emerald-500 rounded-full" />
                    )}
                    <div
                      className={cn(
                        "font-mono text-xs truncate",
                        isSelected
                          ? "text-foreground font-semibold"
                          : "text-foreground/80 group-hover:text-foreground",
                      )}
                    >
                      {tool.name}
                    </div>
                    {tool.description && (
                      <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
                        {tool.description}
                      </div>
                    )}
                  </button>
                );
              })}
              {tools.length === 0 && (
                <div className="px-3 py-8 text-xs text-muted-foreground text-center font-mono tracking-[0.08em]">
                  No tools
                </div>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Tool details + request log */}
        <div
          ref={containerRef}
          className="flex-1 min-w-0 flex flex-col min-h-0"
        >
          <ScrollArea
            className="min-h-0"
            style={{
              flex:
                requestLog.length > 0
                  ? `0 0 ${(1 - logPanelRatio) * 100}%`
                  : "1 1 0%",
            }}
          >
            {selectedTool ? (
              <div className="p-5 space-y-6">
                <div className="pb-4 border-b">
                  <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] text-muted-foreground mb-1.5">
                    <span className="inline-block h-1 w-1 rounded-full bg-emerald-500" />
                    <span>Tool</span>
                  </div>
                  <h3 className="font-mono text-[15px] font-semibold tracking-tight">
                    {selectedTool.name}
                  </h3>
                  {selectedTool.description && (
                    <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                      {selectedTool.description}
                    </p>
                  )}
                </div>

                {/* Parameters */}
                {Object.keys(properties).length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                      <span>Parameters</span>
                      <span className="flex-1 h-px bg-border" />
                      <span className="tabular-nums">
                        {Object.keys(properties).length}
                      </span>
                    </div>
                    <div className="space-y-3">
                      {Object.entries(properties).map(([name, prop]) => {
                        const isRequired = requiredParams.includes(name);
                        return (
                          <div key={name} className="space-y-1.5">
                            <Label className="flex items-baseline gap-2 text-xs">
                              <span className="font-mono font-medium">
                                {name}
                              </span>
                              {prop.type && (
                                <span className="font-mono text-[10px] tracking-wide text-muted-foreground">
                                  {prop.type}
                                </span>
                              )}
                              {isRequired && (
                                <span className="font-mono text-[10px] tracking-wide text-amber-600 dark:text-amber-400">
                                  required
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
                              className="font-mono text-xs"
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Call button */}
                <Button
                  onClick={handleCallTool}
                  disabled={isCallingTool}
                  className="gap-2 font-mono text-xs tracking-[0.08em] h-9 px-4"
                >
                  {isCallingTool ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5 fill-current" />
                  )}
                  Call Tool
                </Button>

                {/* Latest response for this tool */}
                {latestToolCallResponse && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                      <span
                        className={cn(
                          "inline-block h-1 w-1 rounded-full",
                          latestToolCallResponse.error
                            ? "bg-destructive"
                            : "bg-emerald-500",
                        )}
                      />
                      <span>Response</span>
                      <span className="flex-1 h-px bg-border" />
                      <span className="tabular-nums">
                        {latestToolCallResponse.durationMs}
                        <span className="text-muted-foreground/60 ml-0.5">
                          ms
                        </span>
                      </span>
                    </div>
                    <div className="rounded-md bg-zinc-950 border border-zinc-800 overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-zinc-800 flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-zinc-700" />
                        <span className="h-2 w-2 rounded-full bg-zinc-700" />
                        <span className="h-2 w-2 rounded-full bg-zinc-700" />
                      </div>
                      <pre
                        className={cn(
                          "font-mono text-xs leading-relaxed whitespace-pre-wrap p-3 overflow-auto",
                          latestToolCallResponse.error
                            ? "text-rose-400"
                            : "text-emerald-400",
                        )}
                      >
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
                      className="group flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={cn(
                          "h-3 w-3 transition-transform",
                          !showSchema && "-rotate-90",
                        )}
                      />
                      <span>Schema</span>
                    </button>
                    {showSchema && (
                      <div className="rounded-md bg-zinc-950 border border-zinc-800 p-3 mt-2 overflow-auto">
                        <pre className="text-zinc-400 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                          {JSON.stringify(selectedTool.inputSchema, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
                <div className="relative">
                  <div className="h-12 w-12 rounded-md border border-dashed border-muted-foreground/40 flex items-center justify-center">
                    <CircuitBoard className="h-5 w-5 text-muted-foreground/60" />
                  </div>
                </div>
                <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                  Select a tool to inspect
                </span>
              </div>
            )}
          </ScrollArea>

          {/* Request/Response log */}
          {requestLog.length > 0 && (
            <div
              className="flex flex-col min-h-0 bg-muted/10"
              style={{ flex: `0 0 ${logPanelRatio * 100}%` }}
            >
              {/* Drag handle — precision rails */}
              <button
                type="button"
                onPointerDown={handleDragStart}
                aria-label="Resize log panel"
                className="group h-2 flex-shrink-0 cursor-row-resize border-t bg-muted/30 hover:bg-emerald-500/10 active:bg-emerald-500/20 transition-colors flex items-center justify-center relative"
              >
                <div className="flex flex-col gap-[3px]">
                  <span className="block h-px w-10 bg-muted-foreground/30 group-hover:bg-emerald-500/60 transition-colors" />
                  <span className="block h-px w-10 bg-muted-foreground/30 group-hover:bg-emerald-500/60 transition-colors" />
                </div>
              </button>

              <div className="px-4 py-2 flex items-center gap-2 flex-shrink-0 border-b bg-background/50">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                  Request Log
                </span>
                <span className="flex-1" />
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {requestLog.length.toString().padStart(3, "0")}{" "}
                  <span className="text-muted-foreground/60">entries</span>
                </span>
              </div>
              <ScrollArea className="flex-1 min-h-0">
                <div className="divide-y divide-border/50">
                  {requestLog.map((entry, idx) => (
                    <RequestLogItem
                      key={entry.id}
                      entry={entry}
                      index={requestLog.length - idx}
                    />
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

function RequestLogItem({
  entry,
  index,
}: {
  entry: RequestLogEntry;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isError = !!entry.error;
  const method = entry.request.body.method as string;
  const toolName = entry.request.body.toolName as string | undefined;
  const timestamp = new Date(entry.timestamp).toLocaleTimeString([], {
    hour12: false,
  });

  return (
    <div className="text-xs font-mono group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "w-full text-left px-4 py-2 hover:bg-background/60 flex items-center gap-3 transition-colors relative",
          expanded && "bg-background/40",
        )}
      >
        {isError && (
          <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-destructive" />
        )}
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/50 w-6 text-right flex-shrink-0">
          {index.toString().padStart(3, "0")}
        </span>
        <span className="text-muted-foreground/60 tabular-nums flex-shrink-0 text-[10px]">
          {timestamp}
        </span>
        <ChevronDown
          className={cn(
            "h-3 w-3 flex-shrink-0 transition-transform text-muted-foreground",
            !expanded && "-rotate-90",
          )}
        />
        <span
          className={cn(
            "font-semibold flex items-center gap-1.5 flex-shrink-0",
            isError
              ? "text-destructive"
              : "text-emerald-600 dark:text-emerald-400",
          )}
        >
          <span className="inline-block h-1 w-1 rounded-full bg-current" />
          {method}
        </span>
        {toolName && (
          <span className="text-foreground/80 truncate">{toolName}</span>
        )}
        <span className="ml-auto text-muted-foreground tabular-nums flex-shrink-0">
          {entry.durationMs}
          <span className="text-muted-foreground/50 ml-0.5">ms</span>
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pl-[4.25rem] space-y-2.5">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] tracking-[0.08em] text-muted-foreground">
                Request
              </span>
              <span className="flex-1 h-px bg-border/50" />
            </div>
            <div className="rounded bg-zinc-950 border border-zinc-800/60 p-2.5 overflow-auto">
              <pre className="text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {JSON.stringify(entry.request.body, null, 2)}
              </pre>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] tracking-[0.08em] text-muted-foreground">
                Response
              </span>
              <span className="flex-1 h-px bg-border/50" />
            </div>
            <div className="rounded bg-zinc-950 border border-zinc-800/60 p-2.5 overflow-auto">
              <pre
                className={cn(
                  "whitespace-pre-wrap leading-relaxed",
                  isError ? "text-rose-400" : "text-emerald-400",
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
