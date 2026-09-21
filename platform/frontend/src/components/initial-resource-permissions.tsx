// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  archestraApiSdk,
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  type ScopedResource,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { presetFor, subjectLabels } from "@/components/resource-permissions";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "@/components/ui/inline-notice";
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
          You get full access. Choose who else can access this resource when it
          is created; you can update permissions later. Access set in
          organization settings also applies.
        </p>
      </div>
      {grants.length > 0 && (
        <div className="divide-y border-y">
          {grants.map((grant, index) => (
            <div
              key={`${grant.subject.type}:${grant.subject.id}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{grant.name}</p>
                <p className="text-xs text-muted-foreground">
                  {subjectLabels[grant.subject.type]}
                </p>
              </div>
              <Select
                value={presetFor(grant.actions)}
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
                  size="sm"
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
                className="size-8 shrink-0 text-muted-foreground"
                aria-label={`Remove access for ${grant.name}`}
                onClick={() =>
                  onChange(
                    grants.filter((_, entryIndex) => entryIndex !== index),
                  )
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <SearchableSelect
        className="w-full max-w-xs"
        value=""
        ariaLabel="Add initial permission recipient"
        placeholder="Grant access to…"
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
            description: subjectLabels[recipient.subject.type],
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
        <InlineNotice variant="error">
          <AlertCircle />
          <span className="font-medium">Could not load recipients.</span>
          <Button
            type="button"
            variant="link"
            className="ml-auto h-auto p-0"
            onClick={() => void recipients.refetch()}
          >
            <span>Retry</span>
          </Button>
        </InlineNotice>
      )}
    </div>
  );
}
