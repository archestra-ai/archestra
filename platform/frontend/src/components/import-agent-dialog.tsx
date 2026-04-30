"use client";

import type { archestraApiTypes } from "@shared";
import {
  AlertTriangle,
  CheckCircle2,
  FileJson,
  Loader2,
  Upload,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { useImportAgent } from "@/lib/agent.query";
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
  | { status: "importing" }
  | {
      status: "success";
      agentName: string;
      agentId: string;
      warnings: Array<{ type: string; name: string; message: string }>;
    }
  | { status: "error"; message: string };

export function ImportAgentDialog({
  open,
  onOpenChange,
  onSuccess,
}: ImportAgentDialogProps) {
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

        // Basic shape validation
        if (!parsed.version || !parsed.agent?.name) {
          setState({
            status: "error",
            message:
              "Invalid agent configuration file. Missing required fields (version, agent.name).",
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
      reader.readAsText(file);
    },
    [parsePayload],
  );

  const handlePasteImport = useCallback(() => {
    if (!pasteContent.trim()) return;
    parsePayload(pasteContent, null);
  }, [pasteContent, parsePayload]);

  const handleImport = useCallback(async () => {
    if (state.status !== "parsed") return;

    setState({ status: "importing" });

    const result = await importMutation.mutateAsync(state.payload);
    if (!result) {
      setState({
        status: "error",
        message: "Failed to import agent. Please check the server logs.",
      });
      return;
    }

    setState({
      status: "success",
      agentName: result.agent.name,
      agentId: result.agent.id,
      warnings: result.warnings,
    });

    onSuccess?.(
      { id: result.agent.id, name: result.agent.name },
      result.warnings.length,
    );
  }, [state, importMutation, onSuccess]);

  return (
    <FormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Import Agent"
      description="Import an agent configuration from a JSON file previously exported from Archestra."
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
                <div className="space-y-2">
                  <textarea
                    className="h-48 w-full resize-none rounded-md border bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    placeholder='Paste agent JSON here...\n{\n  "version": "1",\n  "agent": { ... }\n}'
                    value={pasteContent}
                    onChange={(e) => setPasteContent(e.target.value)}
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

              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">
                    {state.payload.agent.icon || "🤖"}
                  </span>
                  <div>
                    <p className="font-medium">{state.payload.agent.name}</p>
                    {state.payload.agent.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {state.payload.agent.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {state.payload.tools.length > 0 && (
                    <span>
                      🔧 {state.payload.tools.length} tool
                      {state.payload.tools.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {state.payload.delegations.length > 0 && (
                    <span>
                      🔗 {state.payload.delegations.length} delegation
                      {state.payload.delegations.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {state.payload.knowledgeBases.length > 0 && (
                    <span>
                      📚 {state.payload.knowledgeBases.length} knowledge base
                      {state.payload.knowledgeBases.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {state.payload.connectors.length > 0 && (
                    <span>
                      🔌 {state.payload.connectors.length} connector
                      {state.payload.connectors.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {state.payload.labels.length > 0 && (
                    <span>
                      🏷️ {state.payload.labels.length} label
                      {state.payload.labels.length !== 1 ? "s" : ""}
                    </span>
                  )}
                  {state.payload.suggestedPrompts.length > 0 && (
                    <span>
                      💬 {state.payload.suggestedPrompts.length} suggested
                      prompt
                      {state.payload.suggestedPrompts.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                {state.payload.agent.llmModel && (
                  <p className="text-xs text-muted-foreground">
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

          {/* Importing state */}
          {state.status === "importing" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                Importing agent...
              </p>
            </div>
          )}

          {/* Success state */}
          {state.status === "success" && (
            <div className="space-y-4">
              <Alert
                variant="default"
                className="border-green-500/50 bg-green-50 dark:bg-green-950/50 dark:border-green-500/30"
              >
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                <AlertTitle>Agent Imported Successfully</AlertTitle>
                <AlertDescription>
                  <strong>{state.agentName}</strong> has been created with
                  personal scope.
                </AlertDescription>
              </Alert>

              {state.warnings.length > 0 && (
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>
                    {state.warnings.length} warning
                    {state.warnings.length !== 1 ? "s" : ""}
                  </AlertTitle>
                  <AlertDescription>
                    <ul className="mt-1 space-y-1">
                      {state.warnings.map((w) => (
                        <li key={`${w.type}-${w.name}`} className="text-xs">
                          <strong className="capitalize">{w.type}:</strong>{" "}
                          {w.message}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          )}
        </div>
      </DialogBody>

      <DialogStickyFooter className="mt-0">
        <div className="flex w-full justify-end gap-2">
          {state.status === "success" ? (
            <Button onClick={() => handleOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  if (state.status === "parsed") {
                    resetState();
                  } else {
                    handleOpenChange(false);
                  }
                }}
              >
                {state.status === "parsed" ? "Back" : "Cancel"}
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
                <Button
                  onClick={handleImport}
                  disabled={state.status !== "parsed"}
                >
                  Import Agent
                </Button>
              )}
            </>
          )}
        </div>
      </DialogStickyFooter>
    </FormDialog>
  );
}
