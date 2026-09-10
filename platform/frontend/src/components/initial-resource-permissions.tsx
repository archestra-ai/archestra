// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  archestraApiSdk,
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  type ScopedResource,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { throwOnApiError } from "@/lib/utils";

export type InitialPermissionGrant = ResourcePermissionGrant & { name: string };

/** Controlled fields: the owning wizard submits these with the resource. */
export function InitialResourcePermissions({
  resource,
  grants,
  onChange,
}: {
  resource: ScopedResource;
  grants: InitialPermissionGrant[];
  onChange: (grants: InitialPermissionGrant[]) => void;
}) {
  const [query, setQuery] = useState("");
  const recipients = useQuery({
    queryKey: ["initial-permission-recipients", resource, query],
    queryFn: async () => {
      const { data, error } =
        await archestraApiSdk.searchInitialPermissionSubjects({
          path: { resource },
          query: { query },
        });
      throwOnApiError(error, { toastOnError: false });
      return data ?? [];
    },
  });
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Permissions</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          You receive full access when you create this resource. Choose who else
          can access it. Inherited resource grants also apply.
        </p>
      </div>
      {grants.map((grant, index) => (
        <div
          key={`${grant.subject.type}:${grant.subject.id}`}
          className="flex items-center gap-3 rounded-md border p-3"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{grant.name}</span>
          <Select
            value={
              Object.entries(resourcePermissionPresets).find(
                ([, preset]) =>
                  preset.actions.length === grant.actions.length &&
                  preset.actions.every((action) =>
                    grant.actions.includes(action),
                  ),
              )?.[0] ?? "view"
            }
            onValueChange={(value) => {
              const preset =
                resourcePermissionPresets[
                  value as keyof typeof resourcePermissionPresets
                ];
              onChange(
                grants.map((entry, entryIndex) =>
                  entryIndex === index
                    ? { ...entry, actions: [...preset.actions] }
                    : entry,
                ),
              );
            }}
          >
            <SelectTrigger
              className="w-36"
              aria-label={`Permission for ${grant.name}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(resourcePermissionPresets).map(
                ([key, preset]) => (
                  <SelectItem key={key} value={key}>
                    {preset.label}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove access for ${grant.name}`}
            onClick={() =>
              onChange(grants.filter((_, entryIndex) => entryIndex !== index))
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <SearchableSelect
        className="w-full max-w-md"
        value=""
        ariaLabel="Add initial permission recipient"
        placeholder="Add a user, team, service account, or role"
        searchPlaceholder="Search recipients…"
        onSearchQueryChange={setQuery}
        items={(recipients.data ?? [])
          .filter(
            (recipient) =>
              !grants.some(
                (grant) =>
                  grant.subject.type === recipient.subject.type &&
                  grant.subject.id === recipient.subject.id,
              ),
          )
          .map((recipient) => ({
            value: `${recipient.subject.type}:${recipient.subject.id}`,
            label: recipient.name,
            description:
              recipient.subject.type === "serviceAccount"
                ? "Service account"
                : recipient.subject.type,
          }))}
        onValueChange={(key) => {
          const recipient = recipients.data?.find(
            (entry) => `${entry.subject.type}:${entry.subject.id}` === key,
          );
          if (recipient)
            onChange([...grants, { ...recipient, actions: ["read"] }]);
        }}
      />
      {recipients.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load recipients.{" "}
          <Button
            type="button"
            variant="link"
            onClick={() => void recipients.refetch()}
          >
            Retry
          </Button>
        </p>
      )}
    </div>
  );
}
