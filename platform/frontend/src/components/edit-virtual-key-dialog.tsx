"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { formatExpiration } from "@/components/create-virtual-key-dialog";
import { CreatedByCell } from "@/components/created-by-cell";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
import {
  type ProviderApiKeyMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
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

  useEffect(() => {
    if (!virtualKey) return;
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
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      name,
      expiresAt,
      providerApiKeyIds,
      labels,
    });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={
        <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 pr-5">
          <span>
            {isPassthrough
              ? "Edit Passthrough Virtual Key"
              : "Edit Standard Virtual Key"}
          </span>
          {virtualKey.createdBy && (
            <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
              <span>Created by</span>
              <CreatedByCell createdBy={virtualKey.createdBy} />
            </span>
          )}
        </span>
      }
      description={
        isPassthrough
          ? "Update the passthrough virtual key name and expiration."
          : "Update the standard virtual key name, expiration, and who can reach it."
      }
      size="medium"
      isDirty={isDirty}
    >
      <DialogForm onSubmit={handleUpdate}>
        <DialogBody className="space-y-4">
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
              <ResourceAccessSection
                resource="llmVirtualKey"
                id={virtualKey.id}
              />
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
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          <DialogCancelButton>Cancel</DialogCancelButton>
          <Button type="submit" disabled={!canSubmit}>
            {updateMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>Save Changes</span>
          </Button>
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}
