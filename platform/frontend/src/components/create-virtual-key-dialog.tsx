"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import { Globe, Loader2, User, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
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
import { VirtualKeyConnectionGuide } from "@/components/virtual-key-connection-guide";
import {
  TeamVisibilityPicker,
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import {
  useAllVirtualApiKeys,
  useCreateVirtualApiKey,
} from "@/lib/virtual-api-keys.query";

export type VirtualKeyScope = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["scope"]
>;
export type VirtualKeyType = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["keyType"]
>;
type VirtualKeySummary =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
type CreatedVirtualKey = archestraApiTypes.CreateVirtualApiKeyResponses["200"];

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
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isVirtualKeyAdmin } = useHasPermissions({
    llmVirtualKey: ["admin"],
  });
  const { data: teams = [] } = useTeams({
    enabled: open && !!canReadTeams,
  });
  const defaultExpirationSeconds = useFeature(
    "virtualKeyDefaultExpirationSeconds",
  );
  const visibilityOptions = useMemo(
    () =>
      getVirtualKeyVisibilityOptions({
        canReadTeams: !!canReadTeams,
        isAdmin: !!isVirtualKeyAdmin,
      }),
    [canReadTeams, isVirtualKeyAdmin],
  );

  return (
    <CreateVirtualKeyDialog
      open={open}
      onOpenChange={onOpenChange}
      keyType={keyType}
      parentableKeys={apiKeys}
      connectionBaseUrl={connectionBaseUrl}
      defaultExpirationSeconds={defaultExpirationSeconds ?? null}
      visibilityOptions={visibilityOptions}
      teams={teams}
      canReadTeams={!!canReadTeams}
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
  visibilityOptions,
  teams,
  canReadTeams,
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
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
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
  const [scope, setScope] = useState<VirtualKeyScope>(
    getDefaultVirtualKeyScope(visibilityOptions),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [createdKey, setCreatedKey] = useState<CreatedVirtualKey | null>(null);
  const createdKeyValue = createdKey?.value ?? null;

  const prevOpenRef = useRef(open);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const generatedNameRef = useRef("");

  const isPassthrough = keyType === "passthrough";
  // Passthrough keys are always personal. Admins can mint a key on behalf of
  // another org member; left unset, the key belongs to the creator.
  const showOwnerField = shouldShowOwnerField(
    isVirtualKeyAdmin,
    isPassthrough ? "personal" : scope,
  );
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
      setCreatedKey(null);
      const initialExpiresAt = computeDefaultExpiresAt(
        defaultExpirationSeconds,
      );
      const initialScope = getDefaultVirtualKeyScope(visibilityOptions);
      setNewKeyName(generatedName);
      generatedNameRef.current = generatedName;
      setExpiresAt(initialExpiresAt);
      setScope(initialScope);
      setTeamIds([]);
      setLabels([]);
      setProviderApiKeyIds({});
      setOwnerId("");
      setSelectedOwnerName(null);
      initialSnapshotRef.current = {
        keyType,
        newKeyName: generatedName,
        ownerId: "",
        expiresAt: initialExpiresAt,
        scope: initialScope,
        teamIds: [],
        providerApiKeyIds: {},
        labels: [],
      };
    }
  }, [
    open,
    defaultExpirationSeconds,
    visibilityOptions,
    keyType,
    generatedName,
  ]);

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
  const standardReady =
    (scope !== "team" || teamIds.length > 0) &&
    providerApiKeyMapToArray(providerApiKeyIds).length > 0;
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
      scope,
      teamIds: [...teamIds].sort(),
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
              scope,
              teams: scope === "team" ? teamIds : [],
              providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
              ownerId: owner,
              labels: finalLabels,
            },
      });
      setNewKeyName("");
      if (result?.value) {
        setCreatedKey(result);
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
    scope,
    teamIds,
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
          {createdKey ? (
            <VirtualKeyConnectionGuide
              keyValue={createdKey.value}
              keyType={createdKey.keyType}
              mappedProviderKeys={createdKey.providerApiKeys}
              connectionBaseUrl={connectionBaseUrl}
              name={createdKey.name}
              expiration={formatExpiration(createdKey.expiresAt)}
              visibleTo={getVisibleToLabel(createdKey, currentUser?.id)}
            />
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

              {isPassthrough ? (
                <>
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

                  <div className="space-y-2">
                    <ExpirationDateTimeField
                      value={expiresAt}
                      onChange={setExpiresAt}
                      noExpirationText="Key will never expire"
                      formatExpiration={formatExpiration}
                    />
                  </div>
                </>
              ) : (
                <>
                  <VirtualKeyVisibilityField
                    value={scope}
                    onValueChange={(nextScope) => {
                      setScope(nextScope);
                      if (nextScope !== "team") {
                        setTeamIds([]);
                      }
                    }}
                    teamIds={teamIds}
                    onTeamIdsChange={setTeamIds}
                    teams={teams}
                    canReadTeams={canReadTeams}
                    visibilityOptions={visibilityOptions}
                  />

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

                  <div className="space-y-2">
                    <ExpirationDateTimeField
                      value={expiresAt}
                      onChange={setExpiresAt}
                      noExpirationText="Key will never expire"
                      formatExpiration={formatExpiration}
                    />
                  </div>
                </>
              )}

              <AdvancedLabelsSection
                ref={labelsRef}
                labels={labels}
                onLabelsChange={setLabels}
              />
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

export function VirtualKeyVisibilityField({
  value,
  onValueChange,
  teamIds,
  onTeamIdsChange,
  teams,
  canReadTeams,
  visibilityOptions,
}: {
  value: VirtualKeyScope;
  onValueChange: (value: VirtualKeyScope) => void;
  teamIds: string[];
  onTeamIdsChange: (value: string[]) => void;
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
}) {
  return (
    <VisibilitySelector
      heading="Who can use this virtual key"
      value={value}
      options={visibilityOptions}
      onValueChange={onValueChange}
    >
      {value === "team" && (
        <TeamVisibilityPicker
          disabled={!canReadTeams}
          teams={teams}
          value={teamIds}
          onChange={onTeamIdsChange}
          unavailableMessage={canReadTeams ? undefined : "Teams unavailable"}
        />
      )}
    </VisibilitySelector>
  );
}

function getVisibleToLabel(
  key: CreatedVirtualKey,
  currentUserId: string | undefined,
): string | null {
  if (key.keyType === "passthrough") return null;
  if (key.scope === "org") return "Everyone in the organization";
  if (key.scope === "team")
    return key.teams.map((team) => team.name).join(", ");
  return key.authorId === currentUserId
    ? "Only you"
    : `Only ${key.authorName ?? "the owner"}`;
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

export function getDefaultVirtualKeyScope(
  visibilityOptions: VisibilityOption<VirtualKeyScope>[],
): VirtualKeyScope {
  return (
    visibilityOptions.find((option) => !option.disabled)?.value ?? "personal"
  );
}

export function getVirtualKeyVisibilityOptions(params: {
  isAdmin: boolean;
  canReadTeams: boolean;
}): VisibilityOption<VirtualKeyScope>[] {
  const { isAdmin, canReadTeams } = params;

  return [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can view and manage this virtual key",
      icon: User,
    },
    {
      value: "team",
      label: "Team",
      description: "Visible to selected teams",
      icon: Users,
      disabled: !canReadTeams,
      disabledReason: !canReadTeams
        ? "Team sharing is unavailable without team:read permission"
        : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Visible to everyone in the organization",
      icon: Globe,
      disabled: !isAdmin,
      disabledReason: !isAdmin
        ? "You need llmVirtualKey:admin permission to share org-wide"
        : undefined,
    },
  ];
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
