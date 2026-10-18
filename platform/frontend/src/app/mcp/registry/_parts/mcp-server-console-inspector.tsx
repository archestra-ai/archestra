"use client";

import { archestraApiSdk } from "@archestra/shared";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useReloadMcpServerTools } from "@/lib/mcp/mcp-server.query";
import { cn } from "@/lib/utils/tailwind";
import { ConsoleState, Pulse, StatusItem } from "./mcp-server-console-ui";
import { filterMcpTools } from "./mcp-tool-search";

export type Inspector = ReturnType<typeof useInspector>;

export function useInspector(serverId: string | null, isActive: boolean) {
  const reloadTools = useReloadMcpServerTools();
  const [tools, setTools] = useState<McpTool[]>([]);
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [isCallingTool, setIsCallingTool] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [toolSearch, setToolSearch] = useState("");
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
    if (!serverId) return;
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
        setConnected(false);
        return;
      }
      addLogEntry(body, data, undefined, durationMs);
      const toolsList = (data as { tools?: McpTool[] })?.tools ?? [];
      setTools(toolsList);
      setConnected(true);
      if (toolsList.length > 0) {
        setSelectedTool((prev) =>
          prev && toolsList.some((t) => t.name === prev.name)
            ? prev
            : toolsList[0],
        );
      }
    } catch {
      const durationMs = Math.round(performance.now() - start);
      addLogEntry(body, null, "Failed to connect to MCP server", durationMs);
      setLoadError("Failed to connect to MCP server");
      setConnected(false);
    } finally {
      setIsLoading(false);
    }
  }, [serverId, addLogEntry]);

  useEffect(() => {
    if (isActive && serverId) {
      setTools([]);
      setSelectedTool(null);
      setParamValues({});
      setToolSearch("");
      setConnected(false);
      setRequestLog([]);
      logIdRef.current = 0;
      loadTools();
    }
  }, [isActive, serverId, loadTools]);

  const selectTool = useCallback((tool: McpTool) => {
    setSelectedTool(tool);
    setParamValues({});
    setShowSchema(false);
  }, []);

  const callTool = useCallback(async () => {
    if (!selectedTool || !serverId) return;
    setIsCallingTool(true);
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
      toast.error("Tool call failed");
      addLogEntry(
        body,
        null,
        err instanceof Error ? err.message : "Unknown error",
        durationMs,
      );
    } finally {
      setIsCallingTool(false);
    }
  }, [selectedTool, paramValues, serverId, addLogEntry]);

  const reloadCatalog = useCallback(() => {
    if (!serverId) return;
    reloadTools.mutate({ id: serverId }, { onSuccess: () => void loadTools() });
  }, [serverId, reloadTools, loadTools]);

  return {
    tools,
    selectedTool,
    selectTool,
    isLoading,
    loadError,
    connected,
    paramValues,
    setParamValues,
    isCallingTool,
    callTool,
    showSchema,
    setShowSchema,
    toolSearch,
    setToolSearch,
    requestLog,
    loadTools,
    reloadCatalog,
    isReloading: reloadTools.isPending,
  };
}

export function InspectorStatus({ inspector }: { inspector: Inspector }) {
  const last = inspector.requestLog[0];
  return (
    <>
      <StatusItem>
        {inspector.isLoading ? (
          <>
            <Pulse tone="warn" />
            <span>Connecting</span>
          </>
        ) : inspector.loadError ? (
          <>
            <Pulse tone="err" />
            <span className="text-red-400">Connection failed</span>
          </>
        ) : inspector.connected ? (
          <>
            <Pulse tone="live" />
            <span className="text-emerald-400">Connected</span>
          </>
        ) : (
          <>
            <Pulse tone="off" />
            <span>Idle</span>
          </>
        )}
      </StatusItem>
      {inspector.connected && (
        <StatusItem>
          <span className="tabular-nums text-slate-300">
            {inspector.tools.length}
          </span>
          <span>{inspector.tools.length === 1 ? "tool" : "tools"}</span>
        </StatusItem>
      )}
      {inspector.requestLog.length > 0 && (
        <StatusItem hideBelow="sm">
          <span className="tabular-nums text-slate-300">
            {inspector.requestLog.length}
          </span>
          <span>
            {inspector.requestLog.length === 1 ? "request" : "requests"}
          </span>
        </StatusItem>
      )}
      {last && (
        <StatusItem hideBelow="lg">
          <span className="text-slate-500">last</span>
          <span className={last.error ? "text-red-400" : "text-slate-300"}>
            {String(last.request.body.method)}
          </span>
          <span className="tabular-nums">{last.durationMs}ms</span>
        </StatusItem>
      )}
    </>
  );
}

export function InspectorBody({ inspector }: { inspector: Inspector }) {
  const fieldIdPrefix = useId();
  const [logRatio, setLogRatio] = useState(0.34);
  const containerRef = useRef<HTMLDivElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const seenRequestRef = useRef<number | undefined>(undefined);
  const newest = inspector.requestLog[0];

  // A fresh tool call's response lands below the params; bring it into view.
  useEffect(() => {
    const prev = seenRequestRef.current;
    seenRequestRef.current = newest?.id;
    if (prev === undefined || !newest || newest.id === prev) return;
    if (newest.request.body.method !== "tools/call") return;
    requestAnimationFrame(() =>
      responseRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      }),
    );
  }, [newest]);

  const handleDragStart = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const startY = e.clientY;
      const startRatio = logRatio;
      const h = container.getBoundingClientRect().height;
      const onMove = (ev: globalThis.PointerEvent) => {
        setLogRatio(
          Math.min(0.8, Math.max(0.15, startRatio + (startY - ev.clientY) / h)),
        );
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [logRatio],
  );

  if (inspector.isLoading && inspector.tools.length === 0) {
    return (
      <ConsoleState
        tone="loading"
        title="Connecting to the server"
        detail="Listing the tools it exposes."
      />
    );
  }
  if (inspector.loadError) {
    return (
      <ConsoleState
        tone="error"
        title="Connection failed"
        detail={inspector.loadError}
        action={
          <Button
            variant="outline"
            size="xs"
            onClick={inspector.loadTools}
            className="border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 hover:text-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            <RefreshCw className="size-3" />
            <span>Retry</span>
          </Button>
        }
      />
    );
  }

  const { selectedTool, tools, toolSearch } = inspector;
  const filtered = filterMcpTools(tools, toolSearch);
  const properties = selectedTool?.inputSchema?.properties ?? {};
  const required = selectedTool?.inputSchema?.required ?? [];
  const latest = inspector.requestLog.find(
    (e) =>
      e.request.body.method === "tools/call" &&
      e.request.body.toolName === selectedTool?.name,
  );
  const onFormKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void inspector.callTool();
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Tool list */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800 sm:flex">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-slate-800 px-3">
          <Search className="size-3.5 shrink-0 text-slate-500" />
          <Input
            value={toolSearch}
            onChange={(e) => inspector.setToolSearch(e.target.value)}
            placeholder="Filter tools"
            aria-label="Search tools"
            className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 py-0 font-mono text-xs text-slate-200 shadow-none placeholder:text-slate-600 focus-visible:ring-0 dark:bg-transparent"
          />
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500">
            {toolSearch.trim()
              ? `${filtered.length}/${tools.length}`
              : tools.length}
          </span>
        </div>
        <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="py-1">
            {filtered.map((tool) => {
              const sel = selectedTool?.name === tool.name;
              return (
                <UnstyledButton
                  key={tool.name}
                  onClick={() => inspector.selectTool(tool)}
                  className={cn(
                    "relative block w-full px-3 py-1.5 text-left transition-colors",
                    sel ? "bg-slate-800/60" : "hover:bg-slate-900",
                  )}
                >
                  {sel && (
                    <span className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" />
                  )}
                  <span
                    className={cn(
                      "block truncate font-mono text-xs",
                      sel ? "text-slate-50" : "text-slate-300",
                    )}
                  >
                    {tool.name}
                  </span>
                  {tool.description && (
                    <span className="mt-0.5 block truncate text-[11px] text-slate-500">
                      {tool.description}
                    </span>
                  )}
                </UnstyledButton>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-8 text-center font-mono text-[11px] text-slate-500">
                {tools.length === 0 ? "No tools" : "No matching tools"}
              </p>
            )}
          </div>
        </ScrollArea>
      </aside>

      {/* Detail + request log */}
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileToolPicker inspector={inspector} />
        <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-0 flex-col"
            style={{
              flex:
                inspector.requestLog.length > 0
                  ? `0 0 ${(1 - logRatio) * 100}%`
                  : "1 1 0%",
            }}
          >
            {selectedTool ? (
              <>
                <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcut scope for ⌘↵ */}
                  <div onKeyDown={onFormKey}>
                    <div className="border-b border-slate-800 px-4 py-4 sm:px-5">
                      <h3 className="font-mono text-sm font-semibold text-slate-50">
                        {selectedTool.name}
                      </h3>
                      {selectedTool.description && (
                        <p className="mt-1 max-w-prose text-xs leading-relaxed text-slate-400">
                          {selectedTool.description}
                        </p>
                      )}
                    </div>

                    {Object.keys(properties).length > 0 ? (
                      <div className="divide-y divide-slate-800/70">
                        {Object.entries(properties).map(([name, prop]) => (
                          <label
                            key={name}
                            htmlFor={`${fieldIdPrefix}-${name}`}
                            className="grid grid-cols-[minmax(0,1fr)] items-start gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:gap-4 sm:px-5"
                          >
                            <span className="min-w-0 sm:pt-1.5">
                              <span className="block truncate font-mono text-xs text-slate-200">
                                {name}
                                {required.includes(name) && (
                                  <span className="ml-0.5 text-amber-400">
                                    *
                                  </span>
                                )}
                              </span>
                              {prop.type && (
                                <span className="font-mono text-[11px] text-slate-500">
                                  {prop.type}
                                </span>
                              )}
                            </span>
                            <span className="min-w-0">
                              <Input
                                id={`${fieldIdPrefix}-${name}`}
                                aria-label={name}
                                value={inspector.paramValues[name] ?? ""}
                                placeholder={
                                  prop.enum
                                    ? prop.enum.join(" | ")
                                    : prop.default !== undefined
                                      ? `default: ${JSON.stringify(prop.default)}`
                                      : ""
                                }
                                onChange={(e) =>
                                  inspector.setParamValues((prev) => ({
                                    ...prev,
                                    [name]: e.target.value,
                                  }))
                                }
                                className="h-8 border-slate-800 bg-slate-900/60 px-2.5 py-0 font-mono text-xs text-slate-100 shadow-none transition-colors placeholder:text-slate-600 hover:border-slate-700 focus:bg-slate-900 focus-visible:border-slate-500 focus-visible:ring-0 dark:bg-slate-900/60"
                              />
                              {prop.description && (
                                <span className="mt-1 block text-[11px] leading-snug text-slate-500">
                                  {prop.description}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <p className="px-5 py-4 text-xs text-slate-500">
                        This tool takes no parameters.
                      </p>
                    )}

                    {latest && (
                      <div ref={responseRef}>
                        <ResponseView entry={latest} />
                      </div>
                    )}

                    {inspector.showSchema && selectedTool.inputSchema && (
                      <div className="border-t border-slate-800">
                        <div className="px-5 pt-3 pb-1.5 font-mono text-[11px] text-slate-300">
                          Input schema
                        </div>
                        <pre className="overflow-x-auto px-5 pb-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-400">
                          {JSON.stringify(selectedTool.inputSchema, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </ScrollArea>
                <div className="flex h-11 shrink-0 items-center gap-3 border-t border-slate-800 px-4 sm:px-5">
                  {selectedTool.inputSchema && (
                    <UnstyledButton
                      onClick={() => inspector.setShowSchema((v) => !v)}
                      className="flex items-center gap-1 font-mono text-[11px] text-slate-500 hover:text-slate-200"
                    >
                      <ChevronDown
                        className={cn(
                          "size-3 transition-transform",
                          !inspector.showSchema && "-rotate-90",
                        )}
                      />
                      <span>Schema</span>
                    </UnstyledButton>
                  )}
                  <span className="ml-auto flex items-center gap-3">
                    <span className="hidden font-mono text-[11px] text-slate-600 sm:inline">
                      ⌘↵
                    </span>
                    <Button
                      size="xs"
                      onClick={inspector.callTool}
                      disabled={inspector.isCallingTool}
                      className="bg-slate-100 text-slate-900 hover:bg-white dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                    >
                      {inspector.isCallingTool ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Play className="size-3 fill-current" />
                      )}
                      <span>Call tool</span>
                    </Button>
                  </span>
                </div>
              </>
            ) : (
              <ConsoleState
                tone="info"
                title="Select a tool to inspect"
                detail="Pick a tool on the left to see its parameters and call it."
              />
            )}
          </div>

          {inspector.requestLog.length > 0 && (
            <div
              className="flex min-h-0 flex-col"
              style={{ flex: `0 0 ${logRatio * 100}%` }}
            >
              {/* A 1px divider with a taller invisible grab area. */}
              <UnstyledButton
                onPointerDown={handleDragStart}
                aria-label="Resize request log"
                className="relative h-px shrink-0 cursor-row-resize bg-slate-800 before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] hover:bg-emerald-500/60"
              />
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-slate-800/70 px-5 font-mono text-[11px]">
                <span className="text-slate-300">Requests</span>
                <span className="tabular-nums text-slate-500">
                  {inspector.requestLog.length}
                </span>
              </div>
              <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
                <div className="divide-y divide-slate-800/60">
                  {inspector.requestLog.map((entry, idx) => (
                    <RequestRow
                      key={entry.id}
                      entry={entry}
                      index={inspector.requestLog.length - idx}
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

// ===================== internals =====================

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

/**
 * Phones: the tool list can't sit beside the form, so it collapses into a
 * full-width picker above it (searchable, with descriptions).
 */
function MobileToolPicker({ inspector }: { inspector: Inspector }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { tools, selectedTool } = inspector;
  const filtered = filterMcpTools(tools, query);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <UnstyledButton
          aria-label={`Choose tool (${selectedTool?.name ?? "none"} selected, ${tools.length} tools)`}
          className="flex h-10 w-full shrink-0 items-center gap-2 border-b border-slate-800 px-4 text-left outline-none hover:bg-slate-900 focus-visible:bg-slate-900 data-[state=open]:bg-slate-900 sm:hidden"
        >
          <Zap className="size-3.5 shrink-0 text-slate-500" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-100">
            {selectedTool?.name ?? "Choose a tool"}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-slate-500">
            {tools.length} tools
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-slate-500" />
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={0}
        collisionPadding={12}
        className="w-(--radix-popover-trigger-width) max-w-[calc(100vw-24px)] overflow-hidden p-0"
      >
        <Command shouldFilter={false} loop defaultValue={selectedTool?.name}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Filter tools"
            className="text-xs"
          />
          <CommandList className="max-h-[min(360px,48dvh)]">
            <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
              No matching tools
            </CommandEmpty>
            <CommandGroup>
              {filtered.map((tool) => (
                <CommandItem
                  key={tool.name}
                  value={tool.name}
                  onSelect={() => {
                    inspector.selectTool(tool);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="items-start gap-2 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs">
                      {tool.name}
                    </span>
                    {tool.description && (
                      <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {tool.description}
                      </span>
                    )}
                  </span>
                  <Check
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0",
                      selectedTool?.name !== tool.name && "invisible",
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ResponseView({ entry }: { entry: RequestLogEntry }) {
  const [raw, setRaw] = useState(false);
  const text = mcpText(entry.response);
  const showText = !entry.error && text !== null && !raw;
  return (
    <div className="border-t border-slate-800">
      <div className="flex items-center gap-2 px-5 pt-3 pb-1.5 font-mono text-[11px]">
        <Pulse tone={entry.error ? "err" : "ok"} />
        <span className="text-slate-300">Response</span>
        <span className="tabular-nums text-slate-500">
          {entry.durationMs}ms
        </span>
        {text !== null && !entry.error && (
          <UnstyledButton
            onClick={() => setRaw((v) => !v)}
            className="ml-auto text-slate-500 hover:text-slate-200"
          >
            {raw ? "Show text" : "Show JSON"}
          </UnstyledButton>
        )}
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-5 pb-4 font-mono text-xs leading-relaxed whitespace-pre-wrap",
          entry.error
            ? "text-red-300"
            : showText
              ? "text-slate-200"
              : "text-emerald-300",
        )}
      >
        {showText
          ? text
          : JSON.stringify(
              entry.error ? { error: entry.error } : entry.response,
              null,
              2,
            )}
      </pre>
    </div>
  );
}

/** Joined text blocks of an MCP tool result, or null when it has none. */
function mcpText(response: unknown): string | null {
  const content = (response as { content?: unknown })?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts = content
    .filter(
      (c): c is { type: "text"; text: string } =>
        (c as { type?: string })?.type === "text" &&
        typeof (c as { text?: unknown }).text === "string",
    )
    .map((c) => c.text);
  return texts.length === content.length ? texts.join("\n\n") : null;
}

function RequestRow({
  entry,
  index,
}: {
  entry: RequestLogEntry;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isError = !!entry.error;
  const method = String(entry.request.body.method);
  const toolName = entry.request.body.toolName as string | undefined;
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour12: false,
  });
  return (
    <div className="font-mono text-xs">
      <UnstyledButton
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "relative flex w-full items-center gap-3 px-5 py-1.5 text-left hover:bg-slate-900",
          expanded && "bg-slate-900/70",
        )}
      >
        {isError && (
          <span className="absolute inset-y-0 left-0 w-0.5 bg-red-400" />
        )}
        <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-slate-600">
          {index}
        </span>
        <span className="hidden shrink-0 text-[11px] tabular-nums text-slate-500 sm:inline">
          {time}
        </span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-slate-500 transition-transform",
            !expanded && "-rotate-90",
          )}
        />
        <span
          className={cn(
            "shrink-0",
            isError ? "text-red-400" : "text-emerald-400",
          )}
        >
          {method}
        </span>
        {toolName && (
          <span className="truncate text-slate-300">{toolName}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-slate-500">
          {entry.durationMs}ms
        </span>
      </UnstyledButton>
      {expanded && (
        <div className="grid gap-3 px-5 pt-1 pb-3 pl-[4.75rem] md:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-[11px] text-slate-500">Request</div>
            <pre className="overflow-x-auto leading-relaxed whitespace-pre-wrap text-slate-300">
              {JSON.stringify(entry.request.body, null, 2)}
            </pre>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[11px] text-slate-500">Response</div>
            <pre
              className={cn(
                "overflow-x-auto leading-relaxed whitespace-pre-wrap",
                isError ? "text-red-300" : "text-emerald-300",
              )}
            >
              {entry.error
                ? entry.error
                : JSON.stringify(entry.response, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
