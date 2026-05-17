"use client";

import type { archestraApiTypes } from "@shared";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  FileJson,
  Link as LinkIcon,
  MessageSquare,
  Plug,
  Tag,
  Upload,
  Wrench,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  ConnectorTypeIcon,
  hasConnectorIcon,
} from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { Editor } from "@/components/editor";
import { FormDialog } from "@/components/form-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { useImportAgent } from "@/lib/agent.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

type ImportAgentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: (
    agent: { id: string; name: string },
    warningCount: number,
  ) => void;
};

type ParsedPayload = archestraApiTypes.ImportAgentData["body"];

type ImportState =
  | { status: "idle" }
  | { status: "parsed"; payload: ParsedPayload; fileName: string | null }
  | { status: "error"; message: string }
  | {
      status: "imported";
      agent: { id: string; name: string };
      warnings: Array<{ type: string; name: string; message: string }>;
    };

export function ImportAgentDialog({
  open,
  onOpenChange,
  onSuccess,
}: ImportAgentDialogProps) {
  const appName = useAppName();
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [inputMode, setInputMode] = useState<"file" | "paste">("file");
  const [pasteContent, setPasteContent] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMutation = useImportAgent();

  const resetState = useCallback(() => {
    setState({ status: "idle" });
    setPasteContent("");
    setDragActive(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const handleOpenChange = useCallback(
    (value: boolean) => {
      if (!value) {
        resetState();
      }
      onOpenChange(value);
    },
    [onOpenChange, resetState],
  );

  const parsePayload = useCallback(
    (content: string, fileName: string | null) => {
      try {
        const parsed = JSON.parse(content) as ParsedPayload;

        const missingFields = getMissingPreviewFields(parsed);
        if (missingFields.length > 0) {
          setState({
            status: "error",
            message: `Invalid agent configuration file. Missing required fields (${missingFields.join(", ")}).`,
          });
          return;
        }

        if (parsed.version !== "1") {
          setState({
            status: "error",
            message: `Unsupported version "${parsed.version}". Only version "1" is supported.`,
          });
          return;
        }

        if (parsed.agent.agentType !== "agent") {
          setState({
            status: "error",
            message:
              "Only internal agents can be imported. MCP gateways and LLM proxies are not supported.",
          });
          return;
        }

        setState({ status: "parsed", payload: parsed, fileName });
      } catch {
        setState({
          status: "error",
          message:
            "Invalid JSON file. Please check the file format and try again.",
        });
      }
    },
    [],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        parsePayload(content, file.name);
      };
      reader.onerror = () => {
        setState({
          status: "error",
          message: "Failed to read the file. Please try again.",
        });
      };
      reader.readAsText(file);
    },
    [parsePayload],
  );

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".json")) {
        setState({
          status: "error",
          message: "Only .json files are accepted.",
        });
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target?.result as string;
        parsePayload(content, file.name);
      };
      reader.onerror = () => {
        setState({
          status: "error",
          message: "Failed to read the file. Please try again.",
        });
      };
      reader.readAsText(file);
    },
    [parsePayload],
  );

  const handlePasteImport = useCallback(() => {
    if (!pasteContent.trim()) return;
    parsePayload(pasteContent, null);
  }, [pasteContent, parsePayload]);

  const handleImport = useCallback(() => {
    if (state.status !== "parsed") return;

    importMutation.mutate(state.payload, {
      onSuccess: (result) => {
        if (!result) {
          setState({
            status: "error",
            message: "Import failed. Please try again.",
          });
          return;
        }

        setState({
          status: "imported",
          agent: { id: result.agent.id, name: result.agent.name },
          warnings: result.warnings,
        });

        onSuccess?.(
          { id: result.agent.id, name: result.agent.name },
          result.warnings.length,
        );
      },
      onError: (err) => {
        const maybeMessage =
          typeof err === "object" &&
          err !== null &&
          "error" in err &&
          typeof (err as { error?: unknown }).error === "object" &&
          (err as { error?: unknown }).error !== null &&
          "message" in (err as { error: { message?: unknown } }).error &&
          typeof (err as { error: { message: unknown } }).error.message ===
            "string"
            ? (err as { error: { message: string } }).error.message
            : null;
        setState({
          status: "error",
          message: maybeMessage ?? "Import failed. Please try again.",
        });
      },
    });
  }, [importMutation, onSuccess, state]);

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Import Agent"
      description={`Import an agent configuration from a JSON file previously exported from ${appName}.`}
      size="medium"
    >
      <DialogBody>
        <div className="space-y-4">
          {/* Mode toggle */}
          {state.status === "idle" || state.status === "error" ? (
            <>
              <div className="flex items-center gap-2">
                <Button
                  variant={inputMode === "file" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setInputMode("file");
                    setState({ status: "idle" });
                  }}
                >
                  <Upload className="mr-1.5 h-3.5 w-3.5" />
                  Upload File
                </Button>
                <Button
                  variant={inputMode === "paste" ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setInputMode("paste");
                    setState({ status: "idle" });
                  }}
                >
                  <FileJson className="mr-1.5 h-3.5 w-3.5" />
                  Paste JSON
                </Button>
              </div>

              {/* File picker with drag-and-drop */}
              {inputMode === "file" && (
                <label
                  htmlFor="agent-import-file-input"
                  className={cn(
                    "relative flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
                    dragActive
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50",
                  )}
                  onDragEnter={handleDrag}
                  onDragLeave={handleDrag}
                  onDragOver={handleDrag}
                  onDrop={handleDrop}
                >
                  <Upload className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    Drag and drop a <code>.json</code> file here, or{" "}
                    <span className="font-medium text-primary underline-offset-4 hover:underline">
                      browse
                    </span>
                  </p>
                  <input
                    id="agent-import-file-input"
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={handleFileChange}
                    aria-label="Choose agent configuration file"
                  />
                </label>
              )}

              {/* JSON paste mode */}
              {inputMode === "paste" && (
                <div className="h-64 overflow-hidden rounded-md border">
                  <Editor
                    height="100%"
                    language="json"
                    value={pasteContent}
                    onChange={(value) => setPasteContent(value ?? "")}
                    loading={
                      <div className="flex h-full w-full items-center justify-center bg-muted/50">
                        <p className="text-sm text-muted-foreground">
                          Loading editor...
                        </p>
                      </div>
                    }
                    options={{
                      minimap: { enabled: false },
                      lineNumbers: "on",
                      folding: true,
                      scrollBeyondLastLine: false,
                      wordWrap: "on",
                      fontSize: 13,
                      tabSize: 2,
                      padding: { top: 12, bottom: 12 },
                      automaticLayout: true,
                      scrollbar: {
                        vertical: "auto",
                        horizontal: "auto",
                        verticalScrollbarSize: 10,
                      },
                      ariaLabel: "Paste agent JSON here",
                      placeholder:
                        '{\n\u00A0\u00A0"version": "1",\n\u00A0\u00A0"agent": {\n\u00A0\u00A0\u00A0\u00A0"name": "Example Agent",\n\u00A0\u00A0\u00A0\u00A0"agentType": "agent"\n\u00A0\u00A0},\n\u00A0\u00A0"labels": [],\n\u00A0\u00A0"suggestedPrompts": [],\n\u00A0\u00A0"tools": [],\n\u00A0\u00A0"delegations": [],\n\u00A0\u00A0"knowledgeBases": [],\n\u00A0\u00A0"connectors": []\n}',
                      // Disable EditContext API because Monaco runs inside a Radix Dialog portal.
                      editContext: false,
                    }}
                  />
                </div>
              )}

              {/* Error state */}
              {state.status === "error" && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Invalid Configuration</AlertTitle>
                  <AlertDescription>{state.message}</AlertDescription>
                </Alert>
              )}
            </>
          ) : null}

          {/* Preview state */}
          {state.status === "parsed" && (
            <div className="space-y-4">
              <Alert variant="info">
                <FileJson className="h-4 w-4" />
                <AlertTitle>Ready to Import</AlertTitle>
                <AlertDescription>
                  {state.fileName && (
                    <span className="block text-xs text-muted-foreground mb-1">
                      File: {state.fileName}
                    </span>
                  )}
                </AlertDescription>
              </Alert>

              <div className="rounded-lg border p-4 space-y-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border bg-muted text-2xl">
                    {state.payload.agent.icon || (
                      <Bot className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="font-semibold text-base">
                      {state.payload.agent.name}
                    </p>
                    {state.payload.agent.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">
                        {state.payload.agent.description}
                      </p>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
                  {state.payload.tools.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Wrench className="h-3.5 w-3.5" /> Tools (
                        {state.payload.tools.length})
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {state.payload.tools.slice(0, 3).map((tool) => (
                          <div
                            key={tool.toolName}
                            className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                          >
                            <span className="font-medium truncate">
                              {tool.toolName}
                            </span>
                            {tool.catalogName && (
                              <span className="ml-auto text-[10px] text-muted-foreground px-1.5 py-0.5 rounded bg-background border truncate max-w-[80px]">
                                {tool.catalogName}
                              </span>
                            )}
                          </div>
                        ))}
                        {state.payload.tools.length > 3 && (
                          <div className="text-xs text-muted-foreground px-2">
                            + {state.payload.tools.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {state.payload.connectors.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Plug className="h-3.5 w-3.5" /> Connectors (
                        {state.payload.connectors.length})
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {state.payload.connectors
                          .slice(0, 3)
                          .map((connector) => (
                            <div
                              key={connector.name}
                              className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                            >
                              {hasConnectorIcon(connector.connectorType) ? (
                                <ConnectorTypeIcon
                                  type={connector.connectorType}
                                  className="h-4 w-4 shrink-0"
                                />
                              ) : (
                                <Plug className="h-4 w-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="font-medium truncate">
                                {connector.name}
                              </span>
                            </div>
                          ))}
                        {state.payload.connectors.length > 3 && (
                          <div className="text-xs text-muted-foreground px-2">
                            + {state.payload.connectors.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {state.payload.knowledgeBases.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <BookOpen className="h-3.5 w-3.5" /> Knowledge (
                        {state.payload.knowledgeBases.length})
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {state.payload.knowledgeBases.slice(0, 3).map((kb) => (
                          <div
                            key={kb.name}
                            className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                          >
                            <span className="font-medium truncate">
                              {kb.name}
                            </span>
                          </div>
                        ))}
                        {state.payload.knowledgeBases.length > 3 && (
                          <div className="text-xs text-muted-foreground px-2">
                            + {state.payload.knowledgeBases.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {state.payload.delegations.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <LinkIcon className="h-3.5 w-3.5" /> Delegations (
                        {state.payload.delegations.length})
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {state.payload.delegations.slice(0, 3).map((del) => (
                          <div
                            key={del.targetAgentName}
                            className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                          >
                            <span className="font-medium truncate">
                              {del.targetAgentName}
                            </span>
                          </div>
                        ))}
                        {state.payload.delegations.length > 3 && (
                          <div className="text-xs text-muted-foreground px-2">
                            + {state.payload.delegations.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {state.payload.suggestedPrompts.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <MessageSquare className="h-3.5 w-3.5" /> Prompts (
                        {state.payload.suggestedPrompts.length})
                      </h4>
                      <div className="flex flex-col gap-1.5">
                        {state.payload.suggestedPrompts
                          .slice(0, 3)
                          .map((prompt) => (
                            <div
                              key={prompt.summaryTitle}
                              className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
                            >
                              <span className="font-medium truncate">
                                {prompt.summaryTitle}
                              </span>
                            </div>
                          ))}
                        {state.payload.suggestedPrompts.length > 3 && (
                          <div className="text-xs text-muted-foreground px-2">
                            + {state.payload.suggestedPrompts.length - 3} more
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {state.payload.labels.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                        <Tag className="h-3.5 w-3.5" /> Labels (
                        {state.payload.labels.length})
                      </h4>
                      <div className="flex flex-wrap gap-1.5">
                        {state.payload.labels.slice(0, 5).map((label) => (
                          <span
                            key={label.key}
                            className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium bg-muted/30"
                          >
                            {label.key}: {label.value}
                          </span>
                        ))}
                        {state.payload.labels.length > 5 && (
                          <span className="text-xs text-muted-foreground px-1 self-center">
                            + {state.payload.labels.length - 5} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {state.payload.agent.llmModel && (
                  <p className="text-xs text-muted-foreground mt-4 border-t pt-4">
                    Model:{" "}
                    <code className="rounded bg-muted px-1 py-0.5">
                      {state.payload.agent.llmModel}
                    </code>
                    <span className="ml-1 opacity-60">
                      (informational — not auto-configured)
                    </span>
                  </p>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                The agent will be imported with <strong>personal</strong> scope.
                Tools, knowledge bases, and connectors will be resolved against
                your local registry. Missing references will be reported as
                warnings.
              </p>
            </div>
          )}

          {/* Imported state */}
          {state.status === "imported" && (
            <div className="space-y-4">
              <Alert variant="info">
                <Bot className="h-4 w-4" />
                <AlertTitle>Import Complete</AlertTitle>
                <AlertDescription>
                  <span className="block text-sm">
                    Imported agent: <strong>{state.agent.name}</strong>
                  </span>
                </AlertDescription>
              </Alert>

              {state.warnings.length > 0 && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Imported with warnings</AlertTitle>
                  <AlertDescription>
                    <div className="mt-2 space-y-1">
                      {state.warnings.slice(0, 5).map((w) => (
                        <div key={`${w.type}-${w.name}`} className="text-sm">
                          {w.message}
                        </div>
                      ))}
                      {state.warnings.length > 5 && (
                        <div className="text-xs text-muted-foreground">
                          + {state.warnings.length - 5} more
                        </div>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <p className="text-xs text-muted-foreground">
                You can now close this dialog.
              </p>
            </div>
          )}
        </div>
      </DialogBody>

      <DialogStickyFooter className="mt-0">
        <div className="flex w-full justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              if (state.status === "parsed") {
                resetState();
              } else if (state.status === "imported") {
                handleOpenChange(false);
              } else {
                handleOpenChange(false);
              }
            }}
          >
            {state.status === "parsed"
              ? "Back"
              : state.status === "imported"
                ? "Done"
                : "Cancel"}
          </Button>
          {inputMode === "paste" &&
            (state.status === "idle" || state.status === "error") && (
              <Button
                onClick={handlePasteImport}
                disabled={!pasteContent.trim()}
              >
                Parse JSON
              </Button>
            )}
          {state.status === "parsed" && (
            <Button onClick={handleImport} disabled={importMutation.isPending}>
              {importMutation.isPending ? "Importing..." : "Import Agent"}
            </Button>
          )}
        </div>
      </DialogStickyFooter>
    </FormDialog>
  );
}

function getMissingPreviewFields(payload: ParsedPayload) {
  const missingFields: string[] = [];

  if (!payload.version) {
    missingFields.push("version");
  }
  if (!payload.agent?.name) {
    missingFields.push("agent.name");
  }
  if (!payload.agent?.agentType) {
    missingFields.push("agent.agentType");
  }

  for (const field of PREVIEW_ARRAY_FIELDS) {
    if (!Array.isArray(payload[field])) {
      missingFields.push(field);
    }
  }

  return missingFields;
}

const PREVIEW_ARRAY_FIELDS = [
  "labels",
  "suggestedPrompts",
  "tools",
  "delegations",
  "knowledgeBases",
  "connectors",
] as const;
