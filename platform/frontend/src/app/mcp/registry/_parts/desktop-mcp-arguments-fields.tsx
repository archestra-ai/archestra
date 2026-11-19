"use client";

import { TriangleAlert } from "lucide-react";
import { ContainerArgumentsField } from "@/components/container-deployment-fields";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DesktopArgumentsProgramNotice } from "@/lib/mcp/desktop-mcp";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

/**
 * The command of a desktop MCP server and, under it, the arguments its user
 * adds for their own device: the Command and Arguments pair of a
 * self-hosted server's form. The command is the catalog item's, exactly as
 * stored, and is not the user's to change. The arguments are optional.
 *
 * `notice` goes under the field when the viewer's device runs a program
 * that does not apply arguments. The field stays in use: the arguments are
 * stored, and apply once the device runs a newer program.
 */
export function DesktopMcpArgumentsFields({
  idPrefix,
  name,
  command,
  value,
  onValueChange,
  error,
  disabled,
  notice,
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
  notice?: DesktopArgumentsProgramNotice | null;
}) {
  const commandId = `${idPrefix}-command`;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor={commandId}>Command</Label>
        {/* Out of the tab order: a dialog puts the focus on its first field
            and selects its text, and that must be the arguments, the one
            field the user fills. */}
        <Input
          id={commandId}
          value={command}
          readOnly
          tabIndex={-1}
          className="font-mono"
        />
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
      {notice ? <DesktopMcpArgumentsNotice notice={notice} /> : null}
    </div>
  );
}

/**
 * Says that the viewer's device runs a program from before the arguments,
 * and how to get a newer one when the deployment serves it. See
 * `desktopArgumentsProgramNotice`.
 */
export function DesktopMcpArgumentsNotice({
  notice,
}: {
  notice: DesktopArgumentsProgramNotice;
}) {
  return (
    <InlineNotice variant="warning">
      <TriangleAlert />
      <InlineNoticeBody>
        <span className="font-medium">{notice.title}</span>
        <InlineNoticeText>
          <span>{notice.text.before}</span>
          {notice.text.command ? (
            <code className="font-mono">{notice.text.command}</code>
          ) : null}
          <span>{notice.text.after}</span>
        </InlineNoticeText>
      </InlineNoticeBody>
    </InlineNotice>
  );
}
