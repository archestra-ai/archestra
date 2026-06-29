"use client";

import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import { McpConfigParseError, parseMcpServerConfig } from "./mcp-config-parser";

const EXAMPLE_CONFIG = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_TOKEN_HERE" }
    }
  }
}`;

interface McpConfigImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with parsed form values when the user imports a valid config. */
  onImport: (values: Partial<McpCatalogFormValues>) => void;
}

/**
 * Lets the user paste an MCP server configuration (the `mcpServers` JSON used by
 * most catalogs, a bare server object, or an official-registry `server.json`)
 * and pre-fill the create form from it. See `mcp-config-parser.ts`.
 */
export function McpConfigImportDialog({
  open,
  onOpenChange,
  onImport,
}: McpConfigImportDialogProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Clear transient state whenever the dialog closes so a reopen starts fresh.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setText("");
      setError(null);
    }
    onOpenChange(next);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const { values, warnings } = parseMcpServerConfig(text);
      onImport(values);
      for (const warning of warnings) {
        toast.warning(warning);
      }
      toast.success("Imported configuration into the form.");
      handleOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof McpConfigParseError
          ? caught.message
          : "Couldn't import that configuration.",
      );
    }
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Import from JSON"
      description="Paste an MCP server configuration to pre-fill the form. Secrets and placeholders become prompt-on-install fields."
      size="medium"
      onSubmit={handleSubmit}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={text.trim() === ""}>
            Import
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Textarea
          aria-label="MCP server configuration JSON"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          placeholder={EXAMPLE_CONFIG}
          className="min-h-60 font-mono text-xs"
          spellCheck={false}
        />
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </StandardFormDialog>
  );
}
