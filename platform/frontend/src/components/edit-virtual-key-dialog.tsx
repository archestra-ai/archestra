"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { formatExpiration } from "@/components/create-virtual-key-dialog";
import {
  BudgetFields,
  type SpendCapValue,
  summarizeBudget,
} from "@/components/credential-billing/budget-fields";
import { CreatedByHeader } from "@/components/credential-billing/created-by-header";
import { ProviderKeyBoxes } from "@/components/credential-billing/provider-key-boxes";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
import { useConnectionBaseUrl } from "@/components/virtual-key-connection-base-url";
import { VirtualKeyConnectionGuide } from "@/components/virtual-key-connection-guide";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useUpdateVirtualApiKey } from "@/lib/virtual-api-keys.query";

export type EditableVirtualKey =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];

export function EditVirtualKeyDialog({
  virtualKey,
  onOpenChange,
}: {
  virtualKey: EditableVirtualKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateMutation = useUpdateVirtualApiKey();
  const connectionBaseUrl = useConnectionBaseUrl();
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ProviderApiKeyMappings>([]);
  const [billingTeamId, setBillingTeamId] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState<SpendCapValue>(null);
  const { data: canManageLimits } = useHasPermissions({
    llmLimit: ["update", "delete"],
  });
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  // The permissions section keeps its edits in its own form. This dialog's
  // Save Changes is the only Save on screen, so it has to commit them too.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  // Permission edits live outside this dialog's own snapshot, so the unsaved
  // guard and the Save button need to hear about them separately.
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [activeSection, setActiveSection] = useState<EditSection>("general");

  useEffect(() => {
    if (!virtualKey) return;
    setActiveSection("general");
    const initialExpiresAt = virtualKey.expiresAt
      ? new Date(virtualKey.expiresAt)
      : null;
    const initialProviderApiKeyIds = virtualKey.providerApiKeys.map(
      ({ provider, providerApiKeyId }) => ({ provider, providerApiKeyId }),
    );
    setName(virtualKey.name);
    setLabels(virtualKey.labels);
    setExpiresAt(initialExpiresAt);
    setProviderApiKeyIds(initialProviderApiKeyIds);
    const initialSpendCap = toSpendCapValue(virtualKey.spendCap);
    setBillingTeamId(virtualKey.billingTeamId);
    setSpendCap(initialSpendCap);
    initialSnapshotRef.current = {
      name: virtualKey.name,
      expiresAt: initialExpiresAt,
      providerApiKeyIds: initialProviderApiKeyIds,
      labels: virtualKey.labels,
      billingTeamId: virtualKey.billingTeamId,
      spendCap: initialSpendCap,
    };
  }, [virtualKey]);

  const isPassthrough = virtualKey?.keyType === "passthrough";
  const handleUpdate = useCallback(async () => {
    if (!virtualKey || !name.trim()) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    await permissionsSave.current?.();
    // Unchanged billing is left out, so saving other edits never needs the
    // permission to manage limits.
    const initial = initialSnapshotRef.current;
    const billing = {
      ...(billingTeamId !== initial?.billingTeamId && { billingTeamId }),
      ...(hasUnsavedChanges(
        { spendCap: initial?.spendCap ?? null },
        { spendCap },
      ) && { spendCap }),
    };
    const result = await updateMutation.mutateAsync({
      id: virtualKey.id,
      data: isPassthrough
        ? {
            name: name.trim(),
            keyType: "passthrough",
            expiresAt: expiresAt ?? undefined,
            labels: finalLabels,
            ...billing,
          }
        : {
            name: name.trim(),
            keyType: "standard",
            expiresAt: expiresAt ?? undefined,
            providerApiKeys: providerApiKeyIds,
            labels: finalLabels,
            ...billing,
          },
    });
    if (result) onOpenChange(false);
  }, [
    expiresAt,
    isPassthrough,
    labels,
    name,
    onOpenChange,
    providerApiKeyIds,
    updateMutation,
    virtualKey,
    billingTeamId,
    spendCap,
  ]);

  if (!virtualKey) return null;
  const standardReady = providerApiKeyIds.length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    (isPassthrough || standardReady) &&
    !updateMutation.isPending;
  const isDirty =
    permissionsDirty ||
    (initialSnapshotRef.current !== null &&
      hasUnsavedChanges(initialSnapshotRef.current, {
        name,
        expiresAt,
        providerApiKeyIds,
        labels,
        billingTeamId,
        spendCap,
      }));
  const providerCount = providerApiKeyIds.length;
  const budgetStatus = summarizeBudget({
    billingTeamName:
      billingTeamId === virtualKey.billingTeamId
        ? (virtualKey.billingTeam?.name ?? null)
        : billingTeamId
          ? "A team"
          : null,
    spendCap,
  });

  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={virtualKey.name}
      description={
        isPassthrough
          ? "Update the passthrough virtual key name, budget, and expiration."
          : "Update the standard virtual key's provider keys, budget, and who can reach it."
      }
      sidebarLabel={name || "Virtual key"}
      sidebarDescription={
        isPassthrough ? "Passthrough virtual key" : "Virtual key"
      }
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={activeSection}
      navItems={[
        {
          id: "general",
          label: "General",
          status: expiresAt
            ? `Expires ${formatExpiration(expiresAt)}`
            : "Never expires",
        },
        ...(isPassthrough
          ? []
          : [
              {
                id: "keys" as const,
                label: "Provider keys",
                status: `${providerCount} ${providerCount === 1 ? "provider" : "providers"}`,
              },
            ]),
        { id: "budget", label: "Budget", status: budgetStatus },
        { id: "connect", label: "Connect", status: "Code samples" },
        ...(isPassthrough
          ? []
          : [
              {
                id: "permissions" as const,
                label: "Permissions",
                status: "Who can use it",
              },
            ]),
      ]}
      onActiveSectionChange={setActiveSection}
      onSubmit={() => void handleUpdate()}
      headerExtra={
        <CreatedByHeader
          createdBy={virtualKey.createdBy}
          createdAt={virtualKey.createdAt}
        />
      }
      footer={
        activeSection === "connect" && !isDirty ? (
          <DialogCancelButton>Close</DialogCancelButton>
        ) : (
          <>
            <DialogCancelButton>Cancel</DialogCancelButton>
            <Button type="submit" disabled={!canSubmit}>
              {updateMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              <span>Save Changes</span>
            </Button>
          </>
        )
      }
    >
      <div hidden={activeSection !== "general"} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="edit-virtual-key-name">Name</Label>
          <Input
            id="edit-virtual-key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
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
        />
      </div>
      {!isPassthrough && (
        <div hidden={activeSection !== "keys"} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            <span>
              Requests to a provider go through the key picked for it. Other
              providers are not reachable with this virtual key.
            </span>
          </p>
          <ProviderKeyBoxes
            value={providerApiKeyIds}
            onChange={setProviderApiKeyIds}
            providerApiKeys={providerApiKeys}
          />
        </div>
      )}
      <div hidden={activeSection !== "budget"}>
        <BudgetFields
          subject="key"
          idPrefix="edit-virtual-key"
          billingTeamId={billingTeamId}
          onBillingTeamIdChange={setBillingTeamId}
          spendCap={spendCap}
          onSpendCapChange={setSpendCap}
          capLocked={!!virtualKey.spendCap && !canManageLimits}
          currentUsage={virtualKey.spendCap?.currentUsage ?? null}
        />
      </div>
      {!isPassthrough && (
        <div hidden={activeSection !== "permissions"}>
          <ResourceAccessSection
            resource="llmVirtualKey"
            id={virtualKey.id}
            registerSave={registerPermissionsSave}
            onDirtyChange={setPermissionsDirty}
            standalone
          />
        </div>
      )}
      {activeSection === "connect" && (
        <VirtualKeyConnectionGuide
          keyType={virtualKey.keyType}
          mappedProviderKeys={virtualKey.providerApiKeys}
          connectionBaseUrl={connectionBaseUrl}
          name={virtualKey.name}
          expiration={formatExpiration(virtualKey.expiresAt)}
          visibleTo={null}
        />
      )}
    </TabbedDialogShell>
  );
}

type EditSection = "general" | "keys" | "budget" | "connect" | "permissions";

function toSpendCapValue(cap: EditableVirtualKey["spendCap"]): SpendCapValue {
  return cap
    ? { limitValue: cap.limitValue, cleanupInterval: cap.cleanupInterval }
    : null;
}
