"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { formatExpiration } from "@/components/create-virtual-key-dialog";
import { CreatedByCell } from "@/components/created-by-cell";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import {
  type ProviderApiKeyMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { hasUnsavedChanges } from "@/components/unsaved-changes-guard-utils";
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
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
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
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  useEffect(() => {
    if (!virtualKey) return;
    setActiveSection("general");
    const initialExpiresAt = virtualKey.expiresAt
      ? new Date(virtualKey.expiresAt)
      : null;
    const initialProviderApiKeyIds = Object.fromEntries(
      virtualKey.providerApiKeys.map((mapping) => [
        mapping.provider,
        mapping.providerApiKeyId,
      ]),
    );
    setName(virtualKey.name);
    setLabels(virtualKey.labels);
    setExpiresAt(initialExpiresAt);
    setProviderApiKeyIds(initialProviderApiKeyIds);
    initialSnapshotRef.current = {
      name: virtualKey.name,
      expiresAt: initialExpiresAt,
      providerApiKeyIds: initialProviderApiKeyIds,
      labels: virtualKey.labels,
    };
  }, [virtualKey]);

  const isPassthrough = virtualKey?.keyType === "passthrough";
  const handleUpdate = useCallback(async () => {
    if (!virtualKey || !name.trim()) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    await permissionsSave.current?.();
    const result = await updateMutation.mutateAsync({
      id: virtualKey.id,
      data: isPassthrough
        ? {
            name: name.trim(),
            keyType: "passthrough",
            expiresAt: expiresAt ?? undefined,
            labels: finalLabels,
          }
        : {
            name: name.trim(),
            keyType: "standard",
            expiresAt: expiresAt ?? undefined,
            providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
            labels: finalLabels,
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
  ]);

  if (!virtualKey) return null;
  const standardReady = providerApiKeyMapToArray(providerApiKeyIds).length > 0;
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
      }));

  return (
    <TabbedDialogShell
      open
      onOpenChange={onOpenChange}
      title={
        isPassthrough
          ? "Edit Passthrough Virtual Key"
          : "Edit Standard Virtual Key"
      }
      description={
        isPassthrough
          ? "Update the passthrough virtual key name and expiration."
          : "Update the standard virtual key name, expiration, and who can reach it."
      }
      sidebarLabel={name || "Virtual key"}
      sidebarDescription="Virtual key"
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      isDirty={isDirty}
      activeSection={activeSection}
      navItems={
        isPassthrough
          ? [{ id: "general", label: "General" }]
          : [
              { id: "general", label: "General" },
              { id: "permissions", label: "Permissions" },
            ]
      }
      onActiveSectionChange={setActiveSection}
      onSubmit={() => void handleUpdate()}
      headerExtra={
        virtualKey.createdBy && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Created by</span>
            <CreatedByCell createdBy={virtualKey.createdBy} />
          </span>
        )
      }
      footer={
        <>
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!canSubmit}>
            {updateMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>Save Changes</span>
          </Button>
        </>
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
        {isPassthrough ? (
          <ExpirationDateTimeField
            value={expiresAt}
            onChange={setExpiresAt}
            noExpirationText="Key will never expire"
            formatExpiration={formatExpiration}
          />
        ) : (
          <>
            <ExpirationDateTimeField
              value={expiresAt}
              onChange={setExpiresAt}
              noExpirationText="Key will never expire"
              formatExpiration={formatExpiration}
            />
            <ProviderKeyAccessFields
              providerApiKeyIds={providerApiKeyIds}
              onProviderApiKeyIdsChange={setProviderApiKeyIds}
              providerApiKeys={providerApiKeys}
            />
          </>
        )}
        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
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
    </TabbedDialogShell>
  );
}
