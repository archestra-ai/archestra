"use client";

import type { ReactNode } from "react";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DesktopMcpTargetKind } from "@/lib/mcp/desktop-mcp";

/**
 * The command that starts a desktop MCP server on each user's device. Only
 * stdio servers are offered: the MCP bridge runs the command and talks to the
 * server over its standard input and output.
 *
 * An item saved earlier with a URL keeps it: the field then shows the URL, so
 * a save does not turn it into a command.
 */
export function DesktopMcpTargetField({
  idPrefix,
  kind,
  value,
  onValueChange,
  error,
  autoComplete,
}: {
  idPrefix: string;
  kind: DesktopMcpTargetKind;
  value: string;
  onValueChange: (value: string) => void;
  error?: ReactNode;
  autoComplete?: string;
}) {
  const inputId = `${idPrefix}-value`;
  const option = OPTIONS[kind];
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{option.label}</Label>
      <FieldDescription>{option.description}</FieldDescription>
      <Input
        id={inputId}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={option.placeholder}
        className="font-mono"
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="text-sm font-medium text-destructive">{error}</p>}
    </div>
  );
}

// ===

const OPTIONS: Record<
  DesktopMcpTargetKind,
  { label: string; description: ReactNode; placeholder: string }
> = {
  command: {
    label: "Command",
    description: (
      <>
        <span className="block">
          Starts the MCP server on each user's connected device.
        </span>
        <span className="block">
          <span>You can template the command with </span>
          <Variable>$USER</Variable>
          <span> and </span>
          <Variable>$HOME</Variable>
          <span>
            , which each device fills with its own user name and home folder.
          </span>
        </span>
        <span className="block">
          Each user can add arguments of their own after it.
        </span>
      </>
    ),
    placeholder: "/Users/$USER/bins/mcp",
  },
  url: {
    label: "URL",
    description:
      "Where the MCP server listens on each user's device. New servers use a command.",
    placeholder: "http://127.0.0.1:8080/mcp",
  },
};

function Variable({ children }: { children: string }) {
  return <code className="font-mono text-foreground">{children}</code>;
}
