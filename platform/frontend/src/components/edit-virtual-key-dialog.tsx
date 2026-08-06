"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatExpiration,
  getDefaultVirtualKeyScope,
  getVirtualKeyVisibilityOptions,
  type VirtualKeyScope,
  VirtualKeyVisibilityField,
} from "@/components/create-virtual-key-dialog";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { FormDialog } from "@/components/form-dialog";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useTeams } from "@/lib/teams/team.query";
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
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isVirtualKeyAdmin } = useHasPermissions({
    llmVirtualKey: ["admin"],
  });
  const { data: teams = [] } = useTeams({ enabled: canReadTeams === true });
  const visibilityOptions = useMemo(
    () =>
      getVirtualKeyVisibilityOptions({
        canReadTeams: canReadTeams === true,
        isAdmin: isVirtualKeyAdmin === true,
      }),
    [canReadTeams, isVirtualKeyAdmin],
  );
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [scope, setScope] = useState<VirtualKeyScope>(
    getDefaultVirtualKeyScope(visibilityOptions),
  );
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const initialSnapshotRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!virtualKey) return;
    const initialExpiresAt = virtualKey.expiresAt
      ? new Date(virtualKey.expiresAt)
      : null;
    const initialScope = (virtualKey.scope as VirtualKeyScope) ?? "personal";
    const initialTeamIds = virtualKey.teams.map((team) => team.id);
    const initialProviderApiKeyIds = Object.fromEntries(
      virtualKey.providerApiKeys.map((mapping) => [
        mapping.provider,
        mapping.providerApiKeyId,
      ]),
    );
    setName(virtualKey.name);
    setExpiresAt(initialExpiresAt);
    setScope(initialScope);
    setTeamIds(initialTeamIds);
    setProviderApiKeyIds(initialProviderApiKeyIds);
    initialSnapshotRef.current = {
      name: virtualKey.name,
      expiresAt: initialExpiresAt,
      scope: initialScope,
      teamIds: [...initialTeamIds].sort(),
      providerApiKeyIds: initialProviderApiKeyIds,
    };
  }, [virtualKey]);

  const isPassthrough = virtualKey?.keyType === "passthrough";
  const handleUpdate = useCallback(async () => {
    if (!virtualKey || !name.trim()) return;
    const result = await updateMutation.mutateAsync({
      id: virtualKey.id,
      data: isPassthrough
        ? {
            name: name.trim(),
            keyType: "passthrough",
            expiresAt: expiresAt ?? undefined,
          }
        : {
            name: name.trim(),
            keyType: "standard",
            expiresAt: expiresAt ?? undefined,
            scope,
            teams: scope === "team" ? teamIds : [],
            providerApiKeys: providerApiKeyMapToArray(providerApiKeyIds),
          },
    });
    if (result) onOpenChange(false);
  }, [
    expiresAt,
    isPassthrough,
    name,
    onOpenChange,
    providerApiKeyIds,
    scope,
    teamIds,
    updateMutation,
    virtualKey,
  ]);

  if (!virtualKey) return null;
  const standardReady =
    (scope !== "team" || teamIds.length > 0) &&
    providerApiKeyMapToArray(providerApiKeyIds).length > 0;
  const canSubmit =
    name.trim().length > 0 &&
    (isPassthrough || standardReady) &&
    !updateMutation.isPending;
  const isDirty =
    initialSnapshotRef.current !== null &&
    hasUnsavedChanges(initialSnapshotRef.current, {
      name,
      expiresAt,
      scope,
      teamIds: [...teamIds].sort(),
      providerApiKeyIds,
    });

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title="Edit Virtual API Key"
      description={
        isPassthrough
          ? "Update the passthrough key name and expiration."
          : "Update the virtual key name, visibility, and expiration."
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
              <VirtualKeyVisibilityField
                value={scope}
                onValueChange={(nextScope) => {
                  setScope(nextScope);
                  if (nextScope !== "team") setTeamIds([]);
                }}
                teamIds={teamIds}
                onTeamIdsChange={setTeamIds}
                teams={teams}
                canReadTeams={canReadTeams === true}
                visibilityOptions={visibilityOptions}
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
