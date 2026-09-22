// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  type ScopedResource,
} from "@archestra/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { AddResourceAccessDialog } from "@/components/add-resource-access-dialog";
import {
  presetDescription,
  presetFor,
  subjectLabels,
} from "@/components/resource-permissions";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            You’ll have full access. Add others now or later. Organization
            permissions also apply.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-4" />
          <span>Add access</span>
        </Button>
      </div>
      {grants.length > 0 && (
        <div className="divide-y border-y">
          {grants.map((grant, index) => (
            <div
              key={`${grant.subject.type}:${grant.subject.id}`}
              className="flex items-center gap-3 py-2"
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-sm">{grant.name}</span>
                <span className="text-xs text-muted-foreground">
                  {subjectLabels[grant.subject.type]}
                </span>
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
                  className="w-36 shrink-0 border-transparent bg-transparent shadow-none dark:bg-transparent"
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
      <AddResourceAccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        resource={resource}
        existingSubjects={grants.map((grant) => grant.subject)}
        presets={Object.entries(resourcePermissionPresets).map(
          ([value, preset]) => ({
            value,
            label: preset.label,
            description: presetDescription(value, resource),
            actions: [...preset.actions],
            disabled: false,
          }),
        )}
        onAdd={(added) => onChange([...grants, ...added])}
      />
    </div>
  );
}
