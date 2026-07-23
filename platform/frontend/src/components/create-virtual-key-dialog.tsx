"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import { Globe, Key, Loader2, User, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OwnerSelectField,
  shouldShowOwnerField,
} from "@/app/credentials/virtual-keys/owner-select-field";
import { CopyableCode } from "@/components/copyable-code";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
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
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTime } from "@/lib/utils/date-time";
import { useCreateVirtualApiKey } from "@/lib/virtual-api-keys.query";

export type VirtualKeyScope = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["scope"]
>;
export type VirtualKeyType = NonNullable<
  archestraApiTypes.CreateVirtualApiKeyData["body"]["keyType"]
>;

/**
 * Self-contained variant for surfaces outside the Client Credentials page
 * (e.g. the proxy connect dialog): gathers the option data the form needs.
 */
export function CreateVirtualKeyDialogWithData({
  open,
  onOpenChange,
  initialKeyType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKeyType?: VirtualKeyType;
}) {
  const { data: apiKeys = [] } = useLlmProviderApiKeys({ enabled: open });
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
      initialKeyType={initialKeyType}
      parentableKeys={apiKeys}
      defaultExpirationSeconds={defaultExpirationSeconds ?? null}
      visibilityOptions={visibilityOptions}
      teams={teams}
      canReadTeams={!!canReadTeams}
      isVirtualKeyAdmin={!!isVirtualKeyAdmin}
    />
  );
}

const KEY_TYPE_OPTIONS: {
  value: VirtualKeyType;
  label: string;
  description: string;
}[] = [
  {
    value: "standard",
    label: "Standard",
    description:
      "Maps to provider API keys and is sent in the Authorization header as a provider key replacement.",
  },
  {
    value: "passthrough",
    label: "Passthrough",
    description:
      "Carries no provider key. Sent in the X-Archestra-Virtual-Key header to attribute a request to a user when the provider credential is passed through (e.g. a Claude Code subscription token).",
  },
];

export function CreateVirtualKeyDialog({
  open,
  onOpenChange,
  initialKeyType = "standard",
  parentableKeys,
  defaultExpirationSeconds,
  visibilityOptions,
  teams,
  canReadTeams,
  isVirtualKeyAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Key type preselected when the dialog opens (deep links). */
  initialKeyType?: VirtualKeyType;
  parentableKeys: LlmProviderApiKeyResponse[];
  defaultExpirationSeconds: number | null;
  visibilityOptions: VisibilityOption<VirtualKeyScope>[];
  teams: Array<{ id: string; name: string }>;
  canReadTeams: boolean;
  isVirtualKeyAdmin: boolean;
}) {
  const createMutation = useCreateVirtualApiKey();

  const [keyType, setKeyType] = useState<VirtualKeyType>("standard");
  const [newKeyName, setNewKeyName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [scope, setScope] = useState<VirtualKeyScope>(
    getDefaultVirtualKeyScope(visibilityOptions),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [createdKeyValue, setCreatedKeyValue] = useState<string | null>(null);
  const [createdKeyExpiresAt, setCreatedKeyExpiresAt] = useState<Date | null>(
    null,
  );

  const prevOpenRef = useRef(open);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open && !wasOpen) {
      setCreatedKeyValue(null);
      setCreatedKeyExpiresAt(null);
      const initialExpiresAt = computeDefaultExpiresAt(
        defaultExpirationSeconds,
      );
      const initialScope = getDefaultVirtualKeyScope(visibilityOptions);
      setKeyType(initialKeyType);
      setNewKeyName("");
      setExpiresAt(initialExpiresAt);
      setScope(initialScope);
      setTeamIds([]);
      setProviderApiKeyIds({});
      setOwnerId("");
      initialSnapshotRef.current = {
        keyType: initialKeyType,
        newKeyName: "",
        ownerId: "",
        expiresAt: initialExpiresAt,
        scope: initialScope,
        teamIds: [],
        providerApiKeyIds: {},
      };
    }
  }, [open, defaultExpirationSeconds, visibilityOptions, initialKeyType]);

  const isPassthrough = keyType === "passthrough";
  // Passthrough keys are always personal. Admins can mint a key on behalf of
  // another org member; left unset, the key belongs to the creator.
  const showOwnerField = shouldShowOwnerField(
    isVirtualKeyAdmin,
    isPassthrough ? "personal" : scope,
  );
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
    });

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim()) return;
    const owner = showOwnerField && ownerId ? ownerId : undefined;
    try {
      const result = await createMutation.mutateAsync({
        data: isPassthrough
          ? {
              name: newKeyName.trim(),
              keyType: "passthrough",
              expiresAt: expiresAt ?? undefined,
              ownerId: owner,
            }
          : {
              name: newKeyName.trim(),
              keyType: "standard",
              expiresAt: expiresAt ?? undefined,
              scope,
              teams: scope === "team" ? teamIds : [],
              providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
              ownerId: owner,
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
        createdKeyValue ? "Virtual API Key Created" : "Create Virtual API Key"
      }
      description={
        createdKeyValue
          ? undefined
          : "Map provider API keys, or create a passthrough key to attribute requests to a user."
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
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                Copy this key now. It won&apos;t be shown again.
              </div>
              <div data-testid={E2eTestId.VirtualKeyValue}>
                <CopyableCode value={createdKeyValue} />
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
                  placeholder="My virtual key"
                />
              </div>

              <KeyTypeField value={keyType} onChange={setKeyType} />

              {isPassthrough ? (
                <>
                  {showOwnerField && (
                    <OwnerSelectField value={ownerId} onChange={setOwnerId} />
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
                    <OwnerSelectField value={ownerId} onChange={setOwnerId} />
                  )}

                  <div className="space-y-2">
                    <ExpirationDateTimeField
                      value={expiresAt}
                      onChange={setExpiresAt}
                      noExpirationText="Key will never expire"
                      formatExpiration={formatExpiration}
                    />
                  </div>

                  <ProviderKeyAccessFields
                    providerApiKeyIds={providerApiKeyIds}
                    onProviderApiKeyIdsChange={setProviderApiKeyIds}
                    providerApiKeys={parentableKeys}
                  />
                </>
              )}
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
              Create
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
        <div className="space-y-2">
          <Label>Teams</Label>
          <MultiSelectCombobox
            disabled={!canReadTeams}
            options={teams.map((team) => ({
              value: team.id,
              label: team.name,
            }))}
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={canReadTeams ? "Search teams..." : "Teams unavailable"}
            emptyMessage="No teams found."
          />
        </div>
      )}
    </VisibilitySelector>
  );
}

function KeyTypeField({
  value,
  onChange,
}: {
  value: VirtualKeyType;
  onChange: (value: VirtualKeyType) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Key type</Label>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as VirtualKeyType)}
        className="gap-2"
      >
        {KEY_TYPE_OPTIONS.map((option) => (
          <Label
            key={option.value}
            htmlFor={`virtual-key-type-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[:checked]:border-primary"
          >
            <RadioGroupItem
              id={`virtual-key-type-${option.value}`}
              value={option.value}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <div className="font-medium">{option.label}</div>
              <p className="text-sm text-muted-foreground">
                {option.description}
              </p>
            </div>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}

export function formatExpiration(date: Date | string | null): string {
  return formatRelativeTime(date);
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
