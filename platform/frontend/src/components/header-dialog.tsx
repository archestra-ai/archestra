"use client";

import { Info } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  FieldScopeSelect,
  type FieldScopeValue,
} from "@/components/field-scope-select";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MCP_CONFIG_AUTOCOMPLETE } from "@/lib/mcp/mcp-form-autocomplete";

export interface HeaderDraft {
  headerName: string;
  scope: FieldScopeValue;
  required: boolean;
  value: string;
  description: string;
  includeBearerPrefix: boolean;
  /**
   * When true, the value is treated as credential material:
   *   - Per-installation (`scope === "installation"`): the value input is
   *     masked in install dialogs (storage goes to the install's secret bag).
   *   - Static: server-side validator rejects `sensitive: true` because the
   *     value lives in `userConfig.default` plaintext.
   */
  sensitive: boolean;
}

export type HeaderDialogMode = "add" | "edit";

interface HeaderDialogProps {
  open: boolean;
  mode: HeaderDialogMode;
  initial: HeaderDraft | null;
  existingHeaderNames: string[];
  disableInstallation?: boolean;
  disableInstallationReason?: string;
  onClose: () => void;
  onConfirm: (draft: HeaderDraft) => void;
}

const EMPTY_DRAFT: HeaderDraft = {
  headerName: "",
  scope: "installation",
  required: false,
  value: "",
  description: "",
  includeBearerPrefix: false,
  sensitive: false,
};

export function HeaderDialog({
  open,
  mode,
  initial,
  existingHeaderNames,
  disableInstallation = false,
  disableInstallationReason,
  onClose,
  onConfirm,
}: HeaderDialogProps) {
  const [draft, setDraft] = useState<HeaderDraft>(initial ?? EMPTY_DRAFT);

  useEffect(() => {
    if (open) {
      setDraft(initial ?? EMPTY_DRAFT);
    }
  }, [open, initial]);

  const trimmedName = draft.headerName.trim();
  const duplicate = useMemo(() => {
    if (!trimmedName) return false;
    const lower = trimmedName.toLowerCase();
    return existingHeaderNames.some((n) => n.toLowerCase() === lower);
  }, [existingHeaderNames, trimmedName]);

  const valueRequired = draft.scope === "static";
  const canSubmit =
    trimmedName.length > 0 &&
    !duplicate &&
    (!valueRequired || draft.value.trim().length > 0);

  function updateDraft(patch: Partial<HeaderDraft>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      if (patch.scope && patch.scope !== "installation") {
        next.required = false;
      }
      if (patch.scope && patch.scope !== "static") {
        next.value = "";
      }
      // Server-side validator rejects sensitive + static, so force it off.
      // Other scopes leave the user's Sensitive toggle alone — it's an
      // independent concern from where the value lives.
      if (patch.scope === "static") {
        next.sensitive = false;
      }
      return next;
    });
  }

  function submit() {
    if (!canSubmit) return;
    onConfirm({ ...draft, headerName: trimmedName });
  }

  return (
    <StandardDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="small"
      title={mode === "add" ? "Add header" : "Edit header"}
      description={
        mode === "add" ? "Sent on every request to the MCP server." : undefined
      }
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!canSubmit}>
            {mode === "add" ? "Add header" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="header-name">Header name</Label>
          <Input
            id="header-name"
            value={draft.headerName}
            onChange={(e) => updateDraft({ headerName: e.target.value })}
            placeholder="x-api-key"
            className="font-mono"
            autoComplete={MCP_CONFIG_AUTOCOMPLETE}
          />
          {duplicate && (
            <p className="text-xs text-destructive">
              A header named &quot;{trimmedName}&quot; already exists.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label>Scope</Label>
          <FieldScopeSelect
            value={draft.scope}
            onChange={(scope) => updateDraft({ scope })}
            disableInstallation={disableInstallation}
            disabledReason={disableInstallationReason}
          />
        </div>

        {draft.scope === "installation" && (
          <ScopeCallout
            title="The user enters this when installing"
            body={
              <>
                They&apos;ll see a field labeled{" "}
                <span className="font-mono">
                  &quot;{trimmedName || "header-name"}&quot;
                </span>{" "}
                and your description below as the helper text.
              </>
            }
          />
        )}
        {draft.scope === "static" && (
          <div className="space-y-2">
            <Label htmlFor="header-value">Value</Label>
            <Input
              id="header-value"
              type={draft.sensitive ? "password" : "text"}
              value={draft.value}
              onChange={(e) => updateDraft({ value: e.target.value })}
              placeholder="header value"
              className="font-mono"
              autoComplete={MCP_CONFIG_AUTOCOMPLETE}
            />
          </div>
        )}

        {draft.scope === "installation" && (
          <ToggleCard
            title="Required header"
            body="Block installation until the user supplies a value."
            checked={draft.required}
            onChange={(required) => updateDraft({ required })}
            ariaLabel="Required header"
          />
        )}

        <ToggleCard
          title='Prepend "Bearer "'
          body={
            <>
              The header is sent as{" "}
              <span className="font-mono">
                {trimmedName || "<header-name>"}: Bearer &lt;value&gt;
              </span>
              .
            </>
          }
          checked={draft.includeBearerPrefix}
          onChange={(includeBearerPrefix) =>
            updateDraft({ includeBearerPrefix })
          }
          ariaLabel="Prepend Bearer prefix"
        />

        <ToggleCard
          title="Sensitive value"
          body={
            draft.scope === "static"
              ? "Only available for Installation headers. Static headers are always non-sensitive."
              : "Store this value securely. Use for API tokens, credentials, and other secrets."
          }
          checked={draft.sensitive}
          onChange={(sensitive) => updateDraft({ sensitive })}
          ariaLabel="Sensitive header value"
          disabled={draft.scope === "static"}
          disabledReason="Static headers are always non-sensitive. Use Installation scope for secrets."
        />

        <div className="space-y-2">
          <Label htmlFor="header-description">Description</Label>
          <Textarea
            id="header-description"
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </div>
      </div>
    </StandardDialog>
  );
}

function ScopeCallout({
  title,
  body,
}: {
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="space-y-0.5 text-xs">
        <div className="font-medium text-foreground">{title}</div>
        <div className="text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}

function ToggleCard({
  title,
  body,
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  disabledReason,
}: {
  title: string;
  body: React.ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const card = (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{body}</div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={ariaLabel}
        disabled={disabled}
      />
    </div>
  );
  if (disabled && disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full">{card}</div>
        </TooltipTrigger>
        <TooltipContent>
          <p className="max-w-xs">{disabledReason}</p>
        </TooltipContent>
      </Tooltip>
    );
  }
  return card;
}
