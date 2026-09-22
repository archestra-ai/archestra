"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import { Key, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
// SPDX-SnippetEnd
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import {
  OwnerSelectField,
  shouldShowOwnerField,
} from "@/components/owner-select-field";
import {
  type ProviderApiKeyMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogForm,
  DialogStickyFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import {
  useAllVirtualApiKeys,
  useCreateVirtualApiKey,
} from "@/lib/virtual-api-keys.query";

export type VirtualKeyType = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["keyType"]
>;
type VirtualKeySummary =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

/**
 * Self-contained variant for resource connection surfaces: gathers the option
 * data the form needs.
 */
export function CreateVirtualKeyDialogWithData({
  open,
  onOpenChange,
  keyType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
}) {
  const { data: apiKeys = [] } = useLlmProviderApiKeys({ enabled: open });
  const { data: session } = useSession();
  const connectionBaseUrl = useConnectionBaseUrl();
  const { data: existingKeys } = useAllVirtualApiKeys({
    keyType,
    limit: 100,
    offset: 0,
    enabled: open && keyType === "standard",
    toastOnError: false,
  });
  const { data: isVirtualKeyAdmin } = useHasPermissions({
    llmVirtualKey: ["admin"],
  });
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );

  return (
    <CreateVirtualKeyDialog
      open={open}
      onOpenChange={onOpenChange}
      keyType={keyType}
      parentableKeys={apiKeys}
      connectionBaseUrl={connectionBaseUrl}
      defaultExpirationSeconds={defaultExpirationSeconds ?? null}
      isVirtualKeyAdmin={!!isVirtualKeyAdmin}
      currentUser={
        session?.user
          ? {
              id: session.user.id,
              name: session.user.name ?? session.user.email ?? null,
            }
          : null
      }
      existingKeys={existingKeys?.data ?? []}
    />
  );
}

export function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  keyType,
  parentableKeys,
  connectionBaseUrl,
  defaultExpirationSeconds,
  isVirtualKeyAdmin,
  currentUser,
  existingKeys,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
  parentableKeys: LlmProviderApiKeyResponse[];
  connectionBaseUrl: string;
  defaultExpirationSeconds: number | null;
  isVirtualKeyAdmin: boolean;
  currentUser: { id: string; name: string | null } | null;
  existingKeys: VirtualKeySummary[];
}) {
  const createMutation = useCreateVirtualApiKey();

  const [newKeyName, setNewKeyName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [selectedOwnerName, setSelectedOwnerName] = useState<string | null>(
    null,
  );
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );

  const prevOpenRef = useRef(open);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const generatedNameRef = useRef("");

  const isPassthrough = keyType === "passthrough";
  // Passthrough keys are always personal. Admins can mint a key on behalf of
  // another org member; left unset, the key belongs to the creator.
  const showOwnerField = shouldShowOwnerField(isVirtualKeyAdmin, "personal");
  const effectiveOwnerId =
    showOwnerField && ownerId ? ownerId : currentUser?.id;
  const effectiveOwnerName =
    showOwnerField && ownerId ? selectedOwnerName : currentUser?.name;
  const generatedName = useMemo(
    () =>
      isPassthrough
        ? ""
        : getGeneratedVirtualKeyName({
            ownerId: effectiveOwnerId,
            ownerName: effectiveOwnerName,
            existingKeys,
          }),
    [effectiveOwnerId, effectiveOwnerName, existingKeys, isPassthrough],
  );

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKeyValue(null);
      setCreatedKeyExpiresAt(null);
      const initialExpiresAt = computeDefaultExpiresAt(
        defaultExpirationSeconds,
      );
      setNewKeyName(generatedName);
      generatedNameRef.current = generatedName;
      setExpiresAt(initialExpiresAt);
      setInitialGrants([]);
      setLabels([]);
      setProviderApiKeyIds({});
      setOwnerId("");
      setSelectedOwnerName(null);
      initialSnapshotRef.current = {
        keyType,
        newKeyName: generatedName,
        ownerId: "",
        expiresAt: initialExpiresAt,
        initialGrants: [],
        providerApiKeyIds: {},
        labels: [],
      };
    }
  }, [open, defaultExpirationSeconds, keyType, generatedName]);

  useEffect(() => {
    if (!open || createdKeyValue) return;
    setNewKeyName((currentName) => {
      const shouldUpdate =
        currentName.length === 0 || currentName === generatedNameRef.current;
      generatedNameRef.current = generatedName;
      if (!shouldUpdate) return currentName;
      if (initialSnapshotRef.current) {
        initialSnapshotRef.current = {
          ...initialSnapshotRef.current,
          newKeyName: generatedName,
        };
      }
      return generatedName;
    });
  }, [createdKeyValue, generatedName, open]);
  const standardReady = providerApiKeyMapToArray(providerApiKeyIds).length > 0;
  const canSubmit =
    newKeyName.trim().length > 0 &&
    (isPassthrough || standardReady) &&
    !createMutation.isPending;

  // Once the key is created the form is replaced by the reveal view, so there
  // is nothing left to lose — only guard the editable form.
  const isDirty =
    !createdKeyValue &&
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      keyType,
      newKeyName,
      ownerId,
      expiresAt,
      initialGrants,
      providerApiKeyIds,
      labels,
    });

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim()) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const owner = showOwnerField && ownerId ? ownerId : undefined;
    try {
      const result = await createMutation.mutateAsync({
        data: isPassthrough
          ? {
              name: newKeyName.trim(),
              keyType: "passthrough",
              expiresAt: expiresAt ?? undefined,
              ownerId: owner,
              labels: finalLabels,
            }
          : {
              name: newKeyName.trim(),
              keyType: "standard",
              expiresAt: expiresAt ?? undefined,
              scope: "personal",
              initialGrants: initialGrants.map(
                ({ name: _name, ...grant }) => grant,
              ),
              providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
              ownerId: owner,
              labels: finalLabels,
            },
      });
      setNewKeyName("");
      if (result?.value) {
        setCreatedKeyValue(result.value);
        setCreatedKeyExpiresAt(expiresAt);
      }
    } catch {
      // handled by mutation
    }
  }, [
    createMutation,
    expiresAt,
    isPassthrough,
    labels,
    providerApiKeyIds,
    newKeyName,
    initialGrants,
    showOwnerField,
    ownerId,
  ]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        createdKeyValue
          ? isPassthrough
            ? "Passthrough Virtual Key Created"
            : "Standard Virtual Key Created"
          : isPassthrough
            ? "Create Passthrough Virtual Key"
            : "Create Standard Virtual Key"
      }
      description={
        createdKeyValue
          ? undefined
          : isPassthrough
            ? "Create an attribution key for requests that pass a provider credential through."
            : "Map this standard virtual key to provider API keys."
      }
      size="medium"
      isDirty={isDirty}
    >
      <DialogForm onSubmit={handleCreate}>
        <DialogBody
          className="space-y-4"
          data-testid={E2eTestId.VirtualKeyCreateDialog}
        >
          {createdKeyValue ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Endpoint</h3>
                <TerminalBlock code={`${connectionBaseUrl}/model-router`} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Key className="h-4 w-4" />
                  Copy this key now. It won&apos;t be shown again.
                </div>
                <div data-testid={E2eTestId.VirtualKeyValue}>
                  <TerminalBlock code={createdKeyValue} />
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Expires:</span>{" "}
                {formatExpiration(createdKeyExpiresAt)}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="virtual-key-name">Name</Label>
                <Input
                  id="virtual-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder={
                    isPassthrough ? "My passthrough key" : "My virtual key"
                  }
                />
              </div>

              {!isPassthrough && (
                <ProviderKeyAccessFields
                  providerApiKeyIds={providerApiKeyIds}
                  onProviderApiKeyIdsChange={setProviderApiKeyIds}
                  providerApiKeys={parentableKeys}
                />
              )}

              {/* SPDX-SnippetBegin
                  SPDX-SnippetCopyrightText: 2026 Archestra Inc.
                  SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
              {!isPassthrough && (
                <InitialResourcePermissions
                  resource="llmVirtualKey"
                  grants={initialGrants}
                  onChange={setInitialGrants}
                  ownerName={
                    ownerId
                      ? (selectedOwnerName ?? "Selected owner")
                      : (currentUser?.name ?? "You")
                  }
                />
              )}
              {/* SPDX-SnippetEnd */}
              <ExpirationDateTimeField
                value={expiresAt}
                onChange={setExpiresAt}
                noExpirationText="Key will never expire"
                formatExpiration={formatExpiration}
              />

              <AdvancedLabelsSection
                ref={labelsRef}
                labels={labels}
                onLabelsChange={setLabels}
              >
                {showOwnerField && (
                  <OwnerSelectField
                    value={ownerId}
                    onChange={setOwnerId}
                    onSelectedOwnerChange={(owner) =>
                      setSelectedOwnerName(
                        owner.userId === currentUser?.id
                          ? null
                          : (owner.name ?? owner.email ?? null),
                      )
                    }
                  />
                )}
              </AdvancedLabelsSection>
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>
            {createdKeyValue ? "Close" : "Cancel"}
          </DialogCancelButton>
          {!createdKeyValue && (
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>Create</span>
            </Button>
          )}
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

export function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
}

function getGeneratedVirtualKeyName({
  ownerId,
  ownerName,
  existingKeys,
}: {
  ownerId: string | undefined;
  ownerName: string | null | undefined;
  existingKeys: VirtualKeySummary[];
}): string {
  const ownerLabel = ownerName?.trim();
  const baseName = ownerLabel
    ? `${ownerLabel.endsWith("s") ? `${ownerLabel}'` : `${ownerLabel}'s`} virtual key`
    : "My virtual key";
  const sequence =
    existingKeys.filter(
      (key) => key.authorId === ownerId && key.keyType === "standard",
    ).length + 1;
  return `${baseName} (${sequence})`;
}

function computeDefaultExpiresAt(defaultSeconds: number | null): Date | null {
  if (defaultSeconds === null) return null;
  return new Date(Date.now() + defaultSeconds * 1000);
}

/** Same base-URL resolution as the /connection and /llm/proxy pages. */
function useConnectionBaseUrl(): string {
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  return useMemo(() => {
    const candidates = resolveCandidateBaseUrls({
      externalProxyUrls: config.api.externalProxyUrls,
      internalProxyUrl: config.api.internalProxyUrl,
      metadata: connectionBaseUrls,
    });
    const adminDefault = resolveAdminDefaultBaseUrl(connectionBaseUrls);
    return adminDefault && candidates.includes(adminDefault)
      ? adminDefault
      : candidates[0];
  }, [connectionBaseUrls]);
}
