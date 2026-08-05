"use client";

import { AlertTriangle, FileJson } from "lucide-react";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  type McpConfigImportCandidate,
  parseMcpConfigImport,
} from "./mcp-config-import-parser";

export function McpConfigImportDialog({
  onImport,
  localServersEnabled = true,
}: {
  onImport: (candidate: McpConfigImportCandidate) => void;
  localServersEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState("");
  const [candidates, setCandidates] = useState<McpConfigImportCandidate[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const selected =
    candidates.find((candidate) => candidate.id === selectedId) ??
    candidates[0];

  const reset = () => {
    setJson("");
    setCandidates([]);
    setSelectedId("");
    setError("");
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) reset();
  };

  const handleParse = () => {
    try {
      const parsed = parseMcpConfigImport(json);
      const available = localServersEnabled
        ? parsed
        : parsed.filter((candidate) => candidate.values.serverType !== "local");
      if (!available.length) {
        throw new Error(
          "Self-hosted MCP servers require the Kubernetes orchestrator. Import a remote server instead.",
        );
      }
      const skippedLocalCount = parsed.length - available.length;
      if (skippedLocalCount) {
        for (const candidate of available) {
          candidate.warnings.push(
            `${skippedLocalCount} self-hosted option${skippedLocalCount === 1 ? " was" : "s were"} skipped because the Kubernetes orchestrator is unavailable.`,
          );
        }
      }
      setCandidates(available);
      setSelectedId(available[0]?.id ?? "");
      setError("");
    } catch (parseError) {
      setCandidates([]);
      setSelectedId("");
      setError(
        parseError instanceof Error
          ? parseError.message
          : "The MCP configuration could not be imported.",
      );
    }
  };

  const handleImport = () => {
    if (!selected) return;
    onImport(selected);
    handleOpenChange(false);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <FileJson className="h-4 w-4" />
        <span>Import JSON</span>
      </Button>
      <FormDialog
        open={open}
        onOpenChange={handleOpenChange}
        title="Import MCP Server Configuration"
        description="Paste a client config, a server object, or an official MCP Registry entry."
      >
        <DialogBody className="space-y-4">
          <Textarea
            value={json}
            onChange={(event) => {
              setJson(event.target.value);
              setCandidates([]);
              setSelectedId("");
              setError("");
            }}
            className="min-h-72 resize-y font-mono text-xs"
            placeholder={
              '{\n  "mcpServers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "example-mcp"]\n    }\n  }\n}'
            }
            aria-label="MCP server configuration JSON"
            autoComplete="off"
            spellCheck={false}
          />

          {error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Configuration Not Recognized</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {candidates.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="mcp-config-server">Server to import</Label>
              <Select value={selected?.id} onValueChange={setSelectedId}>
                <SelectTrigger id="mcp-config-server">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                This form creates one catalog entry at a time. Choose which
                server or package option to use.
              </p>
            </div>
          ) : null}

          {selected ? (
            <Alert variant={selected.warnings.length ? "warning" : "info"}>
              {selected.warnings.length ? (
                <AlertTriangle className="h-4 w-4" />
              ) : (
                <FileJson className="h-4 w-4" />
              )}
              <AlertTitle>
                {selected.warnings.length
                  ? "Review Before Saving"
                  : "Configuration Ready"}
              </AlertTitle>
              <AlertDescription>
                {selected.warnings.length ? (
                  <ul className="list-disc space-y-1 pl-4">
                    {selected.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p>The form will be filled with {selected.label}.</p>
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogStickyFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          {selected ? (
            <Button type="button" onClick={handleImport}>
              <span>Import Server</span>
            </Button>
          ) : (
            <Button type="button" onClick={handleParse} disabled={!json.trim()}>
              <span>Review Configuration</span>
            </Button>
          )}
        </DialogStickyFooter>
      </FormDialog>
    </>
  );
}
