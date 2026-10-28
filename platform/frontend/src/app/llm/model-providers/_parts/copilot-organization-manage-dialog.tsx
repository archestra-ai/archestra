"use client";

import { useCallback, useRef, useState } from "react";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { AdvancedFold } from "@/components/git/git-setup-chrome";
import {
  PrivateKeyDrop,
  type PrivateKeyStatus,
} from "@/components/github-app-setup/private-key-drop";
import type { LlmProviderApiKeyResponse as LlmProviderApiKey } from "@/components/llm-provider-api-key-form";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useCopilotGithubAppKeySummary,
  useReplaceCopilotGithubAppPrivateKey,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useUpdateLlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import {
  COPILOT_DIALOG_CLASS,
  CopilotAccess,
  OrganizationRow,
} from "./copilot-organization-parts";

/**
 * Manage an organization's GitHub Copilot plan: the same box and parts as
 * the connect wizard, in its step order, without the stepper. A dropped
 * private key is checked with GitHub right away; Save stores it, then the
 * permissions, then the name and the rest.
 */
export function CopilotOrganizationManageDialog({
  apiKey,
  existingKeys,
  onOpenChange,
}: {
  apiKey: LlmProviderApiKey;
  /** The organization's keys, to tell whether another one is primary. */
  existingKeys: LlmProviderApiKey[];
  onOpenChange: (open: boolean) => void;
}) {
  const summary = useCopilotGithubAppKeySummary(apiKey.id);
  const validate = useValidateExistingCopilotGithubApp();
  const replaceKey = useReplaceCopilotGithubAppPrivateKey();
  const update = useUpdateLlmProviderApiKey();

  const [newKey, setNewKey] = useState<string | null>(null);
  const [name, setName] = useState(apiKey.name);
  const [isPrimary, setIsPrimary] = useState(apiKey.isPrimary ?? false);
  const [labels, setLabels] = useState<ProfileLabel[]>(apiKey.labels ?? []);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  const [permissionsDirty, setPermissionsDirty] = useState(false);

  const otherPrimary =
    existingKeys.find(
      (key) =>
        key.id !== apiKey.id &&
        key.provider === apiKey.provider &&
        key.userId === null &&
        key.isPrimary,
    ) ?? null;
  const detailsChanged =
    name.trim() !== apiKey.name ||
    isPrimary !== (apiKey.isPrimary ?? false) ||
    JSON.stringify(labels) !== JSON.stringify(apiKey.labels ?? []);
  const keyReady = newKey !== null && !!validate.data && !validate.isPending;
  const saving = replaceKey.isPending || update.isPending;
  const canSave =
    !saving &&
    (newKey === null || keyReady) &&
    (keyReady || permissionsDirty || detailsChanged);

  const organization =
    summary.data?.organization ?? apiKey.githubOrganization ?? null;
  const keyStatus: PrivateKeyStatus = replaceKey.error
    ? { kind: "error", message: replaceKey.error.message }
    : validate.isPending
      ? { kind: "checking" }
      : validate.error
        ? { kind: "error", message: validate.error.message }
        : validate.data
          ? { kind: "fingerprint", fingerprint: validate.data.fingerprint }
          : summary.data
            ? { kind: "fingerprint", fingerprint: summary.data.fingerprint }
            : { kind: "idle" };

  async function save() {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    try {
      if (newKey !== null) {
        await replaceKey.mutateAsync({ id: apiKey.id, privateKey: newKey });
      }
      await permissionsSave.current?.();
      if (
        detailsChanged ||
        JSON.stringify(finalLabels) !== JSON.stringify(apiKey.labels ?? [])
      ) {
        await update.mutateAsync({
          id: apiKey.id,
          data: {
            name: name.trim() || undefined,
            isPrimary,
            labels: finalLabels,
          },
        });
      }
      onOpenChange(false);
    } catch {
      // The mutations report their own errors.
    }
  }

  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title="Manage GitHub Copilot"
      description="Your enterprise GitHub Copilot plan. Can be shared."
      size="medium"
      className={COPILOT_DIALOG_CLASS}
      bodyClassName="space-y-5"
      isDirty={newKey !== null || permissionsDirty || detailsChanged}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          <Button type="button" disabled={!canSave} onClick={save}>
            <span>{saving ? "Saving..." : "Save"}</span>
          </Button>
        </>
      }
    >
      {organization ? <OrganizationRow organization={organization} /> : null}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>GitHub App</Label>
          {summary.isPending ? (
            <Skeleton className="h-9 w-48" />
          ) : (
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background">
                <RuntimeCredentialIcon
                  icon={summary.data?.appIcon ?? "logo:github"}
                  className="size-4"
                  size={16}
                />
              </span>
              {summary.data?.appUrl ? (
                <a
                  className="truncate font-medium underline-offset-4 hover:underline"
                  href={summary.data.appUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {appLabel(summary.data)}
                </a>
              ) : (
                <span className="truncate font-medium">
                  {summary.data ? appLabel(summary.data) : "Unknown App"}
                </span>
              )}
            </div>
          )}
        </div>
        <PrivateKeyDrop
          id="copilot-manage-pem"
          status={keyStatus}
          onKey={(key) => {
            replaceKey.reset();
            setNewKey(key);
            if (summary.data)
              validate.mutate({
                appId: summary.data.appId,
                privateKey: key,
                replaceKeyId: apiKey.id,
              });
          }}
        />
      </div>

      <CopilotAccess
        keyId={apiKey.id}
        registerSave={registerPermissionsSave}
        onDirtyChange={setPermissionsDirty}
      />

      <AdvancedFold open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="copilot-manage-name">Name</Label>
            <Input
              id="copilot-manage-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="copilot-manage-primary">Primary key</Label>
              <FieldDescription>
                {otherPrimary
                  ? `"${otherPrimary.name}" is already the primary shared key for this provider.`
                  : "When there are several shared keys for one provider, the primary key is preferred."}
              </FieldDescription>
            </div>
            <Switch
              id="copilot-manage-primary"
              checked={isPrimary}
              onCheckedChange={setIsPrimary}
              disabled={saving || !!otherPrimary}
            />
          </div>
          <ProfileLabels
            ref={labelsRef}
            labels={labels}
            onLabelsChange={setLabels}
          />
        </div>
      </AdvancedFold>
    </StandardDialog>
  );
}

function appLabel(summary: { appName: string | null; appId: string }) {
  return summary.appName ?? `App ${summary.appId}`;
}
