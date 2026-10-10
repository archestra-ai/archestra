"use client";

import { useEffect, useState } from "react";
import type { EnvVarDraft } from "@/components/environment-variable-dialog";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";

/**
 * Bulk-add settings from `KEY=value` lines. A key that looks like a secret is
 * added as a secret without its value — a value pasted here would otherwise
 * be stored as plain text.
 */
export function EnvPasteDialog({
  open,
  mode = "add",
  initialText = "",
  existingKeys,
  normalizeKey = (key) => key,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** `edit` rewrites the plain settings as a whole, from `initialText`. */
  mode?: "add" | "edit";
  initialText?: string;
  existingKeys: readonly string[];
  normalizeKey?: (key: string) => string;
  onClose: () => void;
  onConfirm: (drafts: EnvVarDraft[]) => void;
}) {
  const [text, setText] = useState(initialText);
  useEffect(() => {
    if (open) setText(initialText);
  }, [open, initialText]);
  const parsed = parseEnvLines({ text, existingKeys, normalizeKey });
  const settings = parsed.drafts.filter((draft) => draft.type !== "secret");
  const secrets = parsed.drafts.filter((draft) => draft.type === "secret");
  const editing = mode === "edit";

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      className="sm:max-w-xl"
      isDirty={text !== initialText}
      title={editing ? "Edit settings as .env" : "Paste a .env"}
      description={
        editing
          ? "One KEY=value per line. Removing a line removes the setting."
          : "Add plain settings in one go. One KEY=value per line."
      }
      onSubmit={() => {
        if (editing || parsed.drafts.length) onConfirm(parsed.drafts);
      }}
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button
            type="submit"
            disabled={!editing && parsed.drafts.length === 0}
          >
            {editing
              ? "Save settings"
              : parsed.drafts.length
                ? `Add ${parsed.drafts.length} ${parsed.drafts.length === 1 ? "variable" : "variables"}`
                : "Add variables"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Label htmlFor="env-paste">KEY=value lines</Label>
        <Textarea
          id="env-paste"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          className="font-mono text-xs"
          placeholder={
            "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nNODE_ENV=production"
          }
        />
        {settings.length > 0 && (
          <FieldDescription>
            {settings.length} {settings.length === 1 ? "setting" : "settings"}{" "}
            will be added.
          </FieldDescription>
        )}
        {secrets.length > 0 && (
          <FieldDescription>
            {secrets.map((draft) => draft.key).join(", ")}{" "}
            {secrets.length === 1 ? "looks" : "look"} like a secret, so{" "}
            {secrets.length === 1 ? "it is" : "they are"} added as a secret
            without the pasted value. Set the value after saving.
          </FieldDescription>
        )}
        {parsed.skipped.length > 0 && (
          <FieldDescription>
            Already defined, left as is: {parsed.skipped.join(", ")}.
          </FieldDescription>
        )}
      </div>
    </StandardFormDialog>
  );
}

function parseEnvLines(params: {
  text: string;
  existingKeys: readonly string[];
  normalizeKey: (key: string) => string;
}): { drafts: EnvVarDraft[]; skipped: string[] } {
  const drafts: EnvVarDraft[] = [];
  const skipped: string[] = [];
  const seen = new Set(params.existingKeys);
  for (const rawLine of params.text.split("\n")) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = params.normalizeKey(line.slice(0, separator).trim());
    if (!key) continue;
    if (seen.has(key)) {
      skipped.push(key);
      continue;
    }
    seen.add(key);
    const value = unquote(line.slice(separator + 1).trim());
    const secret = SECRET_KEY_PATTERN.test(key);
    drafts.push({
      key,
      type: secret ? "secret" : "plain_text",
      scope: "static",
      required: secret,
      description: "",
      value: secret ? "" : value,
      credentialId: undefined,
    });
  }
  return { drafts, skipped };
}

function unquote(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

const SECRET_KEY_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY$)/i;
