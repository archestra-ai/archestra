"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import { AdvancedSection } from "@/components/advanced-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import {
  BudgetFields,
  type SpendCapValue,
} from "@/components/credential-billing/budget-fields";
import { ExpirySelect } from "@/components/credential-billing/expiry-select";
import { primaryKeyMappings } from "@/components/credential-billing/provider-key-data";
import { ProviderKeyList } from "@/components/credential-billing/provider-key-list";
import { FormDialog } from "@/components/form-dialog";
import type { InitialPermissionGrant } from "@/components/initial-resource-permissions";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { ProviderAccessField } from "@/components/provider-access-field";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { VirtualKeyConnectionGuide } from "@/components/virtual-key-connection-guide";
import { useScopedCapabilities, useSession } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
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
export type CreatedVirtualKey =
  archestraApiTypes.CreateVirtualApiKeyResponses["200"];

/**
 * Self-contained variant for resource connection surfaces: gathers the option
 * data the form needs.
 */
export function CreateVirtualKeyDialogWithData({
  open,
  onOpenChange,
  keyType,
  initialProviderApiKeys,
  onCreated,
  targetLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
  /** What the key is for, named in the title (e.g. "Model Router"). */
  targetLabel?: string;
  /**
   * Provider keys the new key starts mapped to (standard keys only). Omitted,
   * it starts with the primary key of every provider.
   */
  initialProviderApiKeys?: ProviderApiKeyMappings;
  /**
   * Hands the created key to the caller, which shows its value itself; the
   * dialog then closes instead of switching to its own reveal view.
   */
  onCreated?: (key: CreatedVirtualKey) => void;
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
      defaultExpirationSeconds={
        defaultExpirationSeconds === undefined
          ? 30 * 24 * 60 * 60
          : defaultExpirationSeconds
      }
      currentUser={
        session?.user
          ? {
              id: session.user.id,
              name: session.user.name ?? session.user.email ?? null,
            }
          : null
      }
      existingKeys={existingKeys?.data ?? []}
      initialProviderApiKeys={initialProviderApiKeys}
      onCreated={onCreated}
      targetLabel={targetLabel}
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
  currentUser,
  existingKeys,
  initialProviderApiKeys,
  onCreated,
  targetLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyType: VirtualKeyType;
  parentableKeys: LlmProviderApiKeyResponse[];
  connectionBaseUrl: string;
  defaultExpirationSeconds: number | null;
  currentUser: { id: string; name: string | null } | null;
  existingKeys: VirtualKeySummary[];
  initialProviderApiKeys?: ProviderApiKeyMappings;
  onCreated?: (key: CreatedVirtualKey) => void;
  targetLabel?: string;
}) {
  const createMutation = useCreateVirtualApiKey();

  const { data: capabilities } = useScopedCapabilities();
  const canIncludeFutureProviders =
    capabilities?.some(
      (grant) =>
        grant.resource === "llmProviderApiKey" &&
        grant.action === "use" &&
        grant.scope === "*",
    ) ?? false;
  const [newKeyName, setNewKeyName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [billingTeamId, setBillingTeamId] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState<SpendCapValue>(null);
  const [includeFutureProviders, setIncludeFutureProviders] = useState(false);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ProviderApiKeyMappings>([]);
  const [grants, setGrants] = useState<InitialPermissionGrant[]>([]);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [createdKey, setCreatedKey] = useState<CreatedVirtualKey | null>(null);
  const createdKeyValue = createdKey?.value ?? null;

  // False so a dialog mounted already open is seeded too.
  const prevOpenRef = useRef(false);
  // Read when the dialog opens, not tracked: the form is seeded once per
  // opening, and a re-render with a new array must not wipe the user's edits.
  const initialProviderApiKeysRef = useRef(initialProviderApiKeys);
  initialProviderApiKeysRef.current = initialProviderApiKeys;
  const parentableKeysRef = useRef(parentableKeys);
  parentableKeysRef.current = parentableKeys;
  // Whether the provider keys are seeded for this opening. Without an initial
  // mapping they start as every provider's primary key, which can only be
  // done once the caller's keys have loaded.
  const providerKeysSeededRef = useRef(false);
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const generatedNameRef = useRef("");

  const isPassthrough = keyType === "passthrough";
  const effectiveOwnerId = currentUser?.id;
  const effectiveOwnerName = currentUser?.name;
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
      setIncludeFutureProviders(false);
      const initialExpiresAt = computeDefaultExpiresAt(
        defaultExpirationSeconds,
      );
      setNewKeyName(generatedName);
      generatedNameRef.current = generatedName;
      setExpiresAt(initialExpiresAt);

      const given = initialProviderApiKeysRef.current;
      const initialMappings = isPassthrough
        ? []
        : (given ?? primaryKeyMappings(parentableKeysRef.current));
      providerKeysSeededRef.current =
        isPassthrough ||
        given !== undefined ||
        parentableKeysRef.current.length > 0;
      setProviderApiKeyIds(initialMappings);
      setBillingTeamId(null);
      setSpendCap(null);
      setGrants([]);
      setLabels([]);
      initialSnapshotRef.current = {
        keyType,
        includeFutureProviders: false,
        newKeyName: generatedName,
        expiresAt: initialExpiresAt,
        providerApiKeyIds: initialMappings,
        billingTeamId: null,
        spendCap: null,
        grants: [],
        labels: [],
      };
    }
  }, [open, defaultExpirationSeconds, keyType, generatedName, isPassthrough]);

  // The caller's provider keys arrive after the dialog opened: start with
  // every provider's primary key, unless an initial mapping was given.
  useEffect(() => {
    if (!open || providerKeysSeededRef.current || !parentableKeys.length) {
      return;
    }
    providerKeysSeededRef.current = true;
    const mappings = primaryKeyMappings(parentableKeys);
    setProviderApiKeyIds(mappings);
    if (initialSnapshotRef.current) {
      initialSnapshotRef.current = {
        ...initialSnapshotRef.current,
        providerApiKeyIds: mappings,
      };
    }
  }, [open, parentableKeys]);

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

  const hasProviderKeys =
    isPassthrough || includeFutureProviders || providerApiKeyIds.length > 0;
  const canSubmit =
    newKeyName.trim().length > 0 &&
    hasProviderKeys &&
    !createMutation.isPending;

  // Once the key is created the form is replaced by the reveal view, so there
  // is nothing left to lose — only guard the editable form.
  const isDirty =
    !createdKeyValue &&
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      keyType,
      newKeyName,
      expiresAt,
      includeFutureProviders,
      providerApiKeyIds,
      billingTeamId,
      spendCap,
      grants,
      labels,
    });

  const handleCreate = useCallback(async () => {
    if (!newKeyName.trim()) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const shared = {
      name: newKeyName.trim(),
      expiresAt: expiresAt ?? undefined,
      labels: finalLabels,
      billingTeamId: billingTeamId ?? undefined,
      spendCap: spendCap ?? undefined,
    };
    try {
      const result = await createMutation.mutateAsync({
        data: isPassthrough
          ? { ...shared, keyType: "passthrough" }
          : {
              ...shared,
              keyType: "standard",
              includeFutureProviders,
              providerApiKeys: providerApiKeyIds,
              initialGrants: grants.map(({ subject, actions }) => ({
                subject,
                actions,
              })),
            },
      });
      setNewKeyName("");
      if (result?.value) {
        if (onCreated) {
          onCreated(result);
          onOpenChange(false);
        } else {
          setCreatedKey(result);
        }
      }
    } catch {
      // handled by mutation
    }
  }, [
    createMutation,
    expiresAt,
    grants,
    isPassthrough,
    labels,
    includeFutureProviders,
    providerApiKeyIds,
    newKeyName,
    onCreated,
    onOpenChange,
    billingTeamId,
    spendCap,
  ]);

  const nameInputRef = useRef<HTMLInputElement>(null);
  const noProviderKeys = !isPassthrough && parentableKeys.length === 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      initialFocusRef={nameInputRef}
      title={
        createdKeyValue
          ? isPassthrough
            ? "Passthrough Virtual Key Created"
            : "Standard Virtual Key Created"
          : `New ${isPassthrough ? "passthrough key" : "virtual key"}${
              targetLabel ? ` for ${targetLabel}` : ""
            }`
      }
      description={
        createdKeyValue
          ? undefined
          : isPassthrough
            ? "It links requests that carry your own provider key to you."
            : "Requests with this key go through the provider keys below."
      }
      size={createdKeyValue ? "large" : "small"}
      className={createdKeyValue ? "max-w-4xl" : "sm:max-w-[720px]"}
      isDirty={isDirty}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (createdKeyValue) return;
          if (canSubmit) void handleCreate();
        }}
        className="flex min-h-0 flex-col"
      >
        <DialogBody
          className="space-y-6"
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
              visibleTo={
                createdKey.keyType === "passthrough" ? null : "Only you"
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                <div className="space-y-2">
                  <Label htmlFor="virtual-key-name">Name</Label>
                  <Input
                    id="virtual-key-name"
                    ref={nameInputRef}
                    value={newKeyName}
                    onChange={(event) => setNewKeyName(event.target.value)}
                    placeholder={
                      isPassthrough ? "My passthrough key" : "My virtual key"
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="virtual-key-expires">Expires</Label>
                  <ExpirySelect
                    id="virtual-key-expires"
                    value={expiresAt}
                    onChange={setExpiresAt}
                  />
                </div>
              </div>
              {!isPassthrough && (
                <ProviderAccessField
                  surface="create"
                  canIncludeFutureProviders={canIncludeFutureProviders}
                  includeFutureProviders={includeFutureProviders}
                  onIncludeFutureProvidersChange={(value) => {
                    setIncludeFutureProviders(value);
                    if (value) setProviderApiKeyIds([]);
                  }}
                  current={
                    <ProviderKeyList
                      alwaysOpen
                      emptyLabel={
                        includeFutureProviders
                          ? "Uses primary API keys — add a provider to choose a different key"
                          : "No providers selected — add one below"
                      }
                      value={providerApiKeyIds}
                      onChange={setProviderApiKeyIds}
                      providerApiKeys={parentableKeys}
                    />
                  }
                />
              )}
              <AdvancedSection keepMounted>
                <BudgetFields
                  subject="key"
                  idPrefix="virtual-key"
                  layout="inline"
                  billingTeamId={billingTeamId}
                  onBillingTeamIdChange={setBillingTeamId}
                  spendCap={spendCap}
                  onSpendCapChange={setSpendCap}
                />
                {!isPassthrough && (
                  <ResourceAccessSection
                    resource="llmVirtualKey"
                    grants={grants}
                    onGrantsChange={setGrants}
                  />
                )}
                <AdvancedLabelsSection
                  ref={labelsRef}
                  labels={labels}
                  onLabelsChange={setLabels}
                />
              </AdvancedSection>
            </>
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {noProviderKeys && !createdKeyValue && (
            <p className="mr-auto text-xs text-muted-foreground">
              <span>Add a provider key first.</span>
            </p>
          )}
          <DialogCancelButton>
            {createdKeyValue ? "Close" : "Cancel"}
          </DialogCancelButton>
          {!createdKeyValue && (
            <Button type="submit" disabled={!canSubmit}>
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>Create key</span>
            </Button>
          )}
        </DialogStickyFooter>
      </form>
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
