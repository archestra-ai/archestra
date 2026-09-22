// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  type ScopedResource,
} from "@archestra/shared";
import { Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";
import { AddResourceAccessDialog } from "@/components/add-resource-access-dialog";
import {
  actionSummary,
  PermissionsPanel,
  presetDescription,
  presetFor,
  scopedResourceNouns,
  SubjectIcon,
  subjectLabels,
} from "@/components/resource-permissions";
import { useResourcePermissions } from "@/lib/resource-permissions.query";
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
  scope,
  ownerName,
  grants,
  onChange,
}: {
  resource: ScopedResource;
  scope?: string;
  ownerName?: string;
  grants: InitialPermissionGrant[];
  onChange: (grants: InitialPermissionGrant[]) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  // Organization-wide grants already reach this object the moment it exists.
  // The edit form shows them, so the create form has to as well, or the
  // author believes only the owner can see what they are about to make.
  const organizationPolicy = useResourcePermissions(resource, "*");
  const inherited = organizationPolicy.data?.grants ?? [];
  return (
    <PermissionsPanel embedded>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Permissions</h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {!ownerName && !scope && <span>You’ll have full access. </span>}
            <span>
              Add others now or later. Organization permissions also apply.
            </span>
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setAddOpen(true)}
        >
          <Plus className="size-4" />
          <span>Add access</span>
        </Button>
      </div>
      {/* A rule above the list only. The section that follows draws its own
          top rule, so closing this one too stacks two lines. */}
      {(ownerName || grants.length > 0 || inherited.length > 0) && (
        <div className="divide-y border-t">
          {ownerName && (
            <div className="flex items-center gap-3 py-2 text-sm">
              <UserRound
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">
                {ownerName}
                <span className="ml-2 text-xs text-muted-foreground">
                  Owner
                </span>
              </span>
              {/* Same width and padding as the editable rows' permission
                  select, plus the trash column's spacer, so every row in the
                  list shares one permission column. */}
              <span className="w-36 shrink-0 px-3 text-sm text-muted-foreground">
                Full access
              </span>
              <span className="size-8 shrink-0" />
            </div>
          )}
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
          {inherited.map((grant) => (
            <div
              key={`inherited:${grant.subject.type}:${grant.subject.id}`}
              className="flex items-center gap-3 py-2 text-muted-foreground"
            >
              <SubjectIcon type={grant.subject.type} />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-sm font-medium">
                  {grant.name}
                </span>
                <span className="text-xs">
                  {subjectLabels[grant.subject.type]}
                </span>
                <span className="text-xs">
                  Every {scopedResourceNouns[resource]}
                </span>
              </div>
              <span className="w-36 shrink-0 px-3 text-sm text-muted-foreground">
                {actionSummary(grant.actions, resource)}
              </span>
              <span className="size-8 shrink-0" />
            </div>
          ))}
        </div>
      )}
      <AddResourceAccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        resource={resource}
        scope={scope}
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
    </PermissionsPanel>
  );
}
