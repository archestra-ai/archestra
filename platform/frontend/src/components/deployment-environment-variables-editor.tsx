"use client";

import { Plus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EmptyListState } from "@/components/empty-list-state";
import { EnvPasteDialog } from "@/components/env-paste-dialog";
import {
  type CredentialBindingOption,
  EnvironmentVariableDialog,
  type EnvVarDraft,
} from "@/components/environment-variable-dialog";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

interface DeploymentEnvironmentVariablesEditorProps {
  hideHeading?: boolean;
  value: EnvVarDraft[];
  onChange: (value: EnvVarDraft[]) => void;
  description: ReactNode;
  targetLabel: string;
  installationLabel: string;
  staticLabel: string;
  installationDescription?: string;
  staticDescription?: string;
  installationCalloutTitle: string;
  requiredDescription: string;
  promptedValueLabel: string;
  deferStaticSecretValue?: boolean;
  installationOnlyForSecrets?: boolean;
  allowRequiredStaticSecret?: boolean;
  normalizeKey?: (key: string) => string;
  credentialBindingOptions?: readonly CredentialBindingOption[];
  /** See EnvironmentVariableDialog: creates a credential from the picker. */
  onCreateCredential?: (prefill: {
    key: string;
    description: string;
  }) => Promise<CredentialBindingOption | null>;
}

/**
 * A container runtime's environment: the credentials it logs in with, then
 * the plain settings it reads. Secrets and settings are different things to
 * the reader — one is "can it push to the repo", the other is configuration
 * — so they are listed apart.
 */
export function DeploymentEnvironmentVariablesEditor({
  hideHeading = false,
  value,
  onChange,
  description,
  targetLabel,
  installationLabel,
  staticLabel,
  installationDescription,
  staticDescription,
  installationCalloutTitle,
  requiredDescription,
  promptedValueLabel,
  deferStaticSecretValue = false,
  installationOnlyForSecrets = false,
  allowRequiredStaticSecret = false,
  normalizeKey,
  credentialBindingOptions,
  onCreateCredential,
}: DeploymentEnvironmentVariablesEditorProps) {
  const [dialog, setDialog] = useState<
    { mode: "add" } | { mode: "edit"; index: number } | null
  >(null);
  // `paste` adds lines; `settings` rewrites the plain settings as one .env.
  const [envText, setEnvText] = useState<"paste" | "settings" | null>(null);
  const options = credentialBindingOptions ?? [];
  const entries = value.map((entry, index) => ({ entry, index }));
  const credentials = entries.filter(({ entry }) => entry.type === "secret");
  const settings = entries.filter(({ entry }) => entry.type !== "secret");
  const remove = (index: number) =>
    onChange(value.filter((_, i) => i !== index));
  const awaitingValue = credentials.filter(
    ({ entry }) =>
      entry.required && entry.scope === "static" && !entry.credentialId,
  ).length;
  const summary = [
    countLabel(credentials.length, "credential"),
    countLabel(settings.length, "setting"),
    ...(awaitingValue
      ? [
          `${awaitingValue} ${awaitingValue === 1 ? "needs a value" : "need values"} after saving`,
        ]
      : []),
  ].join(" · ");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          {!hideHeading && (
            <h3 className="text-[15px] font-semibold">
              Credentials and environment
            </h3>
          )}
          {value.length > 0 ? (
            <p className="text-[13px] text-muted-foreground">{summary}</p>
          ) : (
            description && (
              <p className="text-[13px] leading-normal text-muted-foreground">
                {description}
              </p>
            )
          )}
        </div>
        {value.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setDialog({ mode: "add" })}
          >
            <Plus className="size-4" />
            <span>Add</span>
          </Button>
        )}
      </div>

      {value.length === 0 ? (
        <EmptyListState
          message="No credentials or settings yet."
          action={
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setDialog({ mode: "add" })}
              >
                <Plus className="size-4" />
                <span>Add variable</span>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEnvText("paste")}
              >
                Paste .env
              </Button>
            </div>
          }
        />
      ) : (
        <>
          {credentials.length > 0 && (
            <section aria-label="Credentials" className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-[13px] font-semibold">Credentials</h4>
                <span className="text-xs text-muted-foreground">
                  Secret · hidden after saving · never shown to the model
                </span>
              </div>
              <ul className="divide-y">
                {credentials.map(({ entry, index }) => (
                  <li
                    key={`${entry.key}-${index}`}
                    className="grid items-center gap-x-4 gap-y-2 py-3 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
                  >
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-medium">
                          {entry.key}
                        </span>
                        {!entry.required && (
                          <Badge
                            variant="secondary"
                            className="px-1.5 py-0 text-[11px] font-normal"
                          >
                            Optional
                          </Badge>
                        )}
                      </span>
                      {entry.description && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {entry.description}
                        </span>
                      )}
                    </span>
                    <CredentialSource
                      entry={entry}
                      option={options.find(
                        (option) => option.id === entry.credentialId,
                      )}
                      installationLabel={installationLabel}
                      onPick={() => setDialog({ mode: "edit", index })}
                    />
                    <RowActions
                      label={entry.key}
                      onEdit={() => setDialog({ mode: "edit", index })}
                      onRemove={() => remove(index)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {settings.length > 0 && (
            <section aria-label="Settings" className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-[13px] font-semibold">
                  Settings{" "}
                  <span className="font-normal text-muted-foreground">
                    · {countLabel(settings.length, "plain value")}
                  </span>
                </h4>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setEnvText("settings")}
                >
                  Edit as .env
                </Button>
              </div>
              <ul className="divide-y rounded-lg border bg-muted/40 px-2.5">
                {settings.map(({ entry, index }) => (
                  <li
                    key={`${entry.key}-${index}`}
                    className="grid items-center gap-x-3 gap-y-0.5 py-1.5 text-xs sm:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)_auto]"
                  >
                    <span className="truncate font-mono">{entry.key}</span>
                    <span className="truncate font-mono text-muted-foreground">
                      {settingValueLabel(entry, promptedValueLabel)}
                    </span>
                    <RowActions
                      label={entry.key}
                      onEdit={() => setDialog({ mode: "edit", index })}
                      onRemove={() => remove(index)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <EnvironmentVariableDialog
        open={dialog !== null}
        mode={dialog?.mode === "edit" ? "edit" : "add"}
        initial={dialog?.mode === "edit" ? value[dialog.index] : null}
        existingKeys={value
          .filter((_, index) =>
            dialog?.mode === "edit" ? index !== dialog.index : true,
          )
          .map((entry) => entry.key)}
        targetLabel={targetLabel}
        installationLabel={installationLabel}
        staticLabel={staticLabel}
        installationDescription={installationDescription}
        staticDescription={staticDescription}
        installationCalloutTitle={installationCalloutTitle}
        requiredDescription={requiredDescription}
        deferStaticSecretValue={deferStaticSecretValue}
        installationOnlyForSecrets={installationOnlyForSecrets}
        allowRequiredStaticSecret={allowRequiredStaticSecret}
        normalizeKey={normalizeKey}
        credentialBindingOptions={credentialBindingOptions}
        onCreateCredential={onCreateCredential}
        onClose={() => setDialog(null)}
        onConfirm={(draft) => {
          if (dialog?.mode === "edit") {
            onChange(
              value.map((entry, index) =>
                index === dialog.index ? draft : entry,
              ),
            );
          } else {
            onChange([...value, draft]);
          }
          setDialog(null);
        }}
      />
      <EnvPasteDialog
        open={envText !== null}
        mode={envText === "settings" ? "edit" : "add"}
        initialText={
          envText === "settings"
            ? settings
                .filter(({ entry }) => entry.scope === "static")
                .map(({ entry }) => `${entry.key}=${entry.value}`)
                .join("\n")
            : ""
        }
        existingKeys={(envText === "settings"
          ? value.filter(
              (entry) => entry.type === "secret" || entry.scope !== "static",
            )
          : value
        ).map((entry) => entry.key)}
        normalizeKey={normalizeKey}
        onClose={() => setEnvText(null)}
        onConfirm={(drafts) => {
          onChange(
            envText === "settings"
              ? [
                  ...value.filter(
                    (entry) =>
                      entry.type === "secret" || entry.scope !== "static",
                  ),
                  ...drafts,
                ]
              : [...value, ...drafts],
          );
          setEnvText(null);
        }}
      />
    </div>
  );
}

function CredentialSource({
  entry,
  option,
  installationLabel,
  onPick,
}: {
  entry: EnvVarDraft;
  option: CredentialBindingOption | undefined;
  installationLabel: string;
  onPick: () => void;
}) {
  const perPerson = entry.scope === "installation";
  const github = option?.icon === "logo:github";
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          "flex size-[22px] shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
          github
            ? "bg-[#24292F] text-white"
            : option
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground",
        )}
      >
        {option ? (
          <RuntimeCredentialIcon icon={option.icon ?? null} />
        ) : (
          <span className="text-[10px]">—</span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate">
          {option
            ? (option.sourceLabel ?? option.label)
            : perPerson
              ? `${installationLabel} value`
              : "Value for this agent"}
        </span>
        {option || perPerson ? (
          <span
            className={cn(
              "block truncate text-xs",
              perPerson
                ? "text-amber-700 dark:text-amber-400"
                : "text-green-700 dark:text-green-400",
            )}
          >
            {perPerson
              ? "Each person connects on first run"
              : "Organization credential · set"}
          </span>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="link"
            className="h-auto px-0 text-xs"
            onClick={onPick}
          >
            Pick a credential
          </Button>
        )}
      </span>
    </span>
  );
}

function RowActions({
  label,
  onEdit,
  onRemove,
}: {
  label: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <span className="flex justify-end gap-0.5">
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Edit ${label}`}
        onClick={onEdit}
      >
        Edit
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={`Remove ${label}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    </span>
  );
}

function settingValueLabel(entry: EnvVarDraft, promptedValueLabel: string) {
  if (entry.scope === "installation") return `Provided ${promptedValueLabel}`;
  if (!entry.value) return "—";
  // A long encoded blob says nothing useful as text; its size does.
  if (entry.value.length > 120 && /^[A-Za-z0-9+/=]+$/.test(entry.value)) {
    return `${entry.value.slice(0, 32)}… · ${(entry.value.length / 1024).toFixed(1)} KB, base64`;
  }
  return entry.value;
}

function countLabel(count: number, noun: string) {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
