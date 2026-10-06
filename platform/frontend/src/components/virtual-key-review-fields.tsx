"use client";

import type { SupportedProvider } from "@archestra/shared";
import { X } from "lucide-react";
import { type RefObject, useState } from "react";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { OwnerSelectField } from "@/components/owner-select-field";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { UserSelectOption } from "@/components/user-select-option";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { cn } from "@/lib/utils/tailwind";

export type ReviewRowName = "name" | "uses" | "expires" | "owner" | "labels";

/**
 * A new virtual key's settings as a review, not a form: every value starts at
 * a sensible default, so the usual case is one click on Create. Each row shows
 * its value and one action; the action opens just that row, and Done folds it
 * back. The caller names the row that still needs input, which starts open.
 */
export function VirtualKeyReviewFields({
  keyType,
  name,
  onNameChange,
  providerApiKeyIds,
  onProviderApiKeyIdsChange,
  providerApiKeys,
  expiresAt,
  onExpiresAtChange,
  formatExpiration,
  showOwnerField,
  ownerId,
  ownerName,
  onOwnerChange,
  onSelectedOwnerChange,
  labels,
  onLabelsChange,
  labelsRef,
  initialOpen,
}: {
  /** The row that still needs input when the dialog opens, if any. */
  initialOpen: ReviewRowName | null;
  keyType: "standard" | "passthrough";
  name: string;
  onNameChange: (name: string) => void;
  providerApiKeyIds: ProviderApiKeyMappings;
  onProviderApiKeyIdsChange: (value: ProviderApiKeyMappings) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
  expiresAt: Date | null;
  onExpiresAtChange: (value: Date | null) => void;
  formatExpiration: (value: Date | string | null) => string;
  showOwnerField: boolean;
  ownerId: string;
  /** The chosen owner's name; null means the creator. */
  ownerName: string | null;
  onOwnerChange: (userId: string) => void;
  onSelectedOwnerChange: (owner: UserSelectOption) => void;
  labels: ProfileLabel[];
  onLabelsChange: (labels: ProfileLabel[]) => void;
  labelsRef: RefObject<ProfileLabelsRef | null>;
}) {
  const providerCatalog = useModelProviderCatalog();
  const isStandard = keyType === "standard";
  const [open, setOpen] = useState<ReviewRowName | null>(initialOpen);
  const toggle = (row: ReviewRowName) => setOpen(open === row ? null : row);
  const keyName = (id: string) =>
    providerApiKeys.find((key) => key.id === id)?.name ?? "Unknown key";

  return (
    <dl className="divide-y">
      <ReviewRow
        label="Name"
        isOpen={open === "name"}
        action="Rename"
        onToggle={() => toggle("name")}
        summary={name || <Muted>Not set</Muted>}
      >
        <Input
          id="virtual-key-name"
          aria-label="Name"
          autoFocus
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && name.trim()) {
              event.preventDefault();
              setOpen(null);
            }
          }}
          placeholder={isStandard ? "My virtual key" : "My passthrough key"}
        />
      </ReviewRow>

      {isStandard && (
        <ReviewRow
          label="Uses"
          isOpen={open === "uses"}
          action="Change"
          onToggle={() => toggle("uses")}
          summary={
            providerApiKeyIds.length ? (
              <span className="flex flex-wrap gap-1.5">
                {providerApiKeyIds.map((mapping) => (
                  <Chip key={mapping.providerApiKeyId}>
                    {providerCatalog.label(mapping.provider)} ·{" "}
                    {keyName(mapping.providerApiKeyId)}
                  </Chip>
                ))}
              </span>
            ) : (
              <Muted>No provider key yet</Muted>
            )
          }
        >
          <ProviderKeysEditor
            value={providerApiKeyIds}
            onChange={onProviderApiKeyIdsChange}
            providerApiKeys={providerApiKeys}
          />
        </ReviewRow>
      )}

      <ReviewRow
        label="Expires"
        isOpen={open === "expires"}
        action="Change"
        onToggle={() => toggle("expires")}
        summary={expiresAt ? formatExpiration(expiresAt) : "Never"}
      >
        <ExpiryEditor value={expiresAt} onChange={onExpiresAtChange} />
      </ReviewRow>

      {showOwnerField && (
        <ReviewRow
          label="Owner"
          isOpen={open === "owner"}
          action="Change"
          onToggle={() => toggle("owner")}
          summary={ownerName ?? "You"}
        >
          <OwnerSelectField
            value={ownerId}
            onChange={onOwnerChange}
            onSelectedOwnerChange={onSelectedOwnerChange}
          />
        </ReviewRow>
      )}

      <ReviewRow
        label="Labels"
        isOpen={open === "labels"}
        action={labels.length ? "Change" : "Add"}
        onToggle={() => toggle("labels")}
        summary={
          labels.length ? (
            <span className="flex flex-wrap gap-1.5">
              {labels.map((label) => (
                <Chip key={label.key}>
                  {label.key}: {label.value}
                </Chip>
              ))}
            </span>
          ) : (
            <Muted>None</Muted>
          )
        }
      >
        <ProfileLabels
          ref={labelsRef}
          labels={labels}
          onLabelsChange={onLabelsChange}
        />
      </ReviewRow>
    </dl>
  );
}

// =========================================================================
// Rows
// =========================================================================

function ReviewRow({
  label,
  isOpen,
  action,
  onToggle,
  summary,
  children,
}: {
  label: string;
  isOpen: boolean;
  action: string;
  onToggle: () => void;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "py-3",
        isOpen && "-mx-3 my-1 rounded-lg border bg-muted/30 px-3",
      )}
    >
      <div className="flex min-h-8 items-center gap-3">
        <dt className="w-20 shrink-0 text-sm text-muted-foreground">{label}</dt>
        <dd className="min-w-0 flex-1 text-sm">{!isOpen && summary}</dd>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-8 px-0 text-muted-foreground"
          aria-expanded={isOpen}
          aria-label={isOpen ? `Done editing ${label}` : `${action} ${label}`}
          onClick={onToggle}
        >
          {isOpen ? "Done" : action}
        </Button>
      </div>
      {isOpen && <div className="mt-2">{children}</div>}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">
      {children}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

// =========================================================================
// Editors
// =========================================================================

/**
 * One line per provider: which of its keys to use (a virtual key maps one key
 * per provider), and remove. Another provider is added from a picker of those
 * that have keys and are not mapped yet.
 */
function ProviderKeysEditor({
  value,
  onChange,
  providerApiKeys,
}: {
  value: ProviderApiKeyMappings;
  onChange: (value: ProviderApiKeyMappings) => void;
  providerApiKeys: LlmProviderApiKeyResponse[];
}) {
  const providerCatalog = useModelProviderCatalog();
  const keysOf = (provider: SupportedProvider) =>
    providerApiKeys.filter((key) => key.provider === provider);
  const unmapped = [
    ...new Set(providerApiKeys.map((key) => key.provider)),
  ].filter((provider) => !value.some((m) => m.provider === provider));

  return (
    <div className="space-y-2">
      {value.map((mapping) => (
        <div key={mapping.provider} className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-sm text-muted-foreground">
            {providerCatalog.label(mapping.provider)}
          </span>
          <Select
            value={mapping.providerApiKeyId}
            onValueChange={(providerApiKeyId) =>
              onChange(
                value.map((m) =>
                  m.provider === mapping.provider
                    ? { ...m, providerApiKeyId }
                    : m,
                ),
              )
            }
          >
            <SelectTrigger
              aria-label={`${providerCatalog.label(mapping.provider)} key`}
              className="h-8 flex-1"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {keysOf(mapping.provider).map((key) => (
                <SelectItem key={key.id} value={key.id}>
                  {key.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Stop using ${providerCatalog.label(mapping.provider)}`}
            onClick={() =>
              onChange(value.filter((m) => m.provider !== mapping.provider))
            }
          >
            <X />
          </Button>
        </div>
      ))}
      {unmapped.length > 0 && (
        <Select
          value=""
          onValueChange={(provider) => {
            const first = keysOf(provider as SupportedProvider)[0];
            if (first) {
              onChange([
                ...value,
                {
                  provider: provider as SupportedProvider,
                  providerApiKeyId: first.id,
                },
              ]);
            }
          }}
        >
          <SelectTrigger
            aria-label="Use another provider"
            className="h-8 w-56 border-dashed"
          >
            <SelectValue placeholder="+ Use another provider" />
          </SelectTrigger>
          <SelectContent>
            {unmapped.map((provider) => (
              <SelectItem key={provider} value={provider}>
                {providerCatalog.label(provider)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_PRESETS = [
  { value: "7", label: "In 7 days", days: 7 },
  { value: "30", label: "In 30 days", days: 30 },
  { value: "90", label: "In 90 days", days: 90 },
] as const;

/** Presets for the usual choices; a date picker only for a custom date. */
function ExpiryEditor({
  value,
  onChange,
}: {
  value: Date | null;
  onChange: (value: Date | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const preset = value
    ? EXPIRY_PRESETS.find(
        (p) =>
          Math.abs(value.getTime() - Date.now() - p.days * DAY_MS) < DAY_MS / 2,
      )
    : null;
  const selected = !value
    ? "never"
    : !custom && preset
      ? preset.value
      : "custom";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={selected}
        onValueChange={(next) => {
          if (next === "never") {
            setCustom(false);
            onChange(null);
          } else if (next === "custom") {
            setCustom(true);
            onChange(value ?? new Date(Date.now() + 30 * DAY_MS));
          } else {
            setCustom(false);
            const days =
              EXPIRY_PRESETS.find((p) => p.value === next)?.days ?? 30;
            onChange(new Date(Date.now() + days * DAY_MS));
          }
        }}
      >
        <SelectTrigger aria-label="Expires" className="h-8 w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {EXPIRY_PRESETS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
          <SelectItem value="never">Never</SelectItem>
          <SelectItem value="custom">Custom date…</SelectItem>
        </SelectContent>
      </Select>
      {selected === "custom" && (
        <DateTimePicker
          value={value ?? undefined}
          onChange={(date) => onChange(date ?? null)}
          disabledDate={(date) => date < new Date(new Date().toDateString())}
          className="flex-1"
        />
      )}
    </div>
  );
}
