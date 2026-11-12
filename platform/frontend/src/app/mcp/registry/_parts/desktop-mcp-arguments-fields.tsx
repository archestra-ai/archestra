"use client";

import { ContainerArgumentsField } from "@/components/container-deployment-fields";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

/**
 * The command of a desktop MCP server and, under it, the arguments its user
 * adds for their own device: the Command and Arguments pair of a
 * self-hosted server's form. The command is the catalog item's, exactly as
 * stored, and is not the user's to change. The arguments are optional.
 */
export function DesktopMcpArgumentsFields({
  idPrefix,
  name,
  command,
  value,
  onValueChange,
  error,
  disabled,
}: {
  idPrefix: string;
  /** The name of the MCP server. */
  name: string;
  command: string;
  /** The text of the arguments, one per line. */
  value: string;
  onValueChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
}) {
  const commandId = `${idPrefix}-command`;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={commandId}>Command</Label>
        <Input id={commandId} value={command} readOnly className="font-mono" />
      </div>
      <ContainerArgumentsField
        id={`${idPrefix}-arguments`}
        value={value}
        onChange={onValueChange}
        placeholder={"/path/to/folder\n--verbose"}
        description={`Optional. Added after the command when the MCP bridge starts ${name} on your device.`}
        error={error}
        autoComplete={MCP_CONFIG_AUTOCOMPLETE}
        disabled={disabled}
      />
    </div>
  );
}
