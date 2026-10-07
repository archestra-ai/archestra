// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  resourcePermissionPresetsFor,
  type ScopedResource,
} from "@archestra/shared";
import { Info, Plus, Trash2, UserRound } from "lucide-react";
import { useState } from "react";
import { AddResourceAccessDialog } from "@/components/add-resource-access-dialog";
import { PermissionLevelSelect } from "@/components/permission-level-select";
import {
  PermissionsSettingsSection,
  permissionsSettingsDescription,
} from "@/components/permissions-settings-section";
import {
  actionSummary,
  PermissionsPanel,
  presetDescription,
  presetFor,
  ResourcePermissionsDialog,
  resourcePluralNames,
  SubjectIcon,
  scopedResourceNouns,
  subjectLabels,
} from "@/components/resource-permissions";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useHasPermissions,
  useScopedCapabilities,
} from "@/lib/auth/auth.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";

export type InitialPermissionGrant = ResourcePermissionGrant & { name: string };

/** Controlled fields: the owning wizard submits these with the resource. */
export function InitialResourcePermissions({
  resource,
  scope,
  ownerName,
  grants,
  onChange,
  standalone,
  layout = "default",
  showHeader = true,
}: {
  resource: ScopedResource;
  scope?: string;
  ownerName?: string;
  grants: InitialPermissionGrant[];
  onChange: (grants: InitialPermissionGrant[]) => void;
  /** Set when the section is a tab pane of its own, not one field among many. */
  standalone?: boolean;
  /** Match the title-left, controls-right layout of settings forms. */
  layout?: "default" | "settings";
  /** The enclosing configuration row already supplies its heading and helper. */
  showHeader?: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [allPermissionsOpen, setAllPermissionsOpen] = useState(false);
  // Organization-wide grants already reach this object the moment it exists.
  // The edit form shows them, so the create form has to as well, or the
  // author believes only the owner can see what they are about to make.
  const { data: canReadGlobal } = useHasPermissions({
    accessPolicies: ["read"],
  });
  const { data: canUpdateGlobal } = useHasPermissions({
    accessPolicies: ["update"],
  });
  const organizationPolicy = useResourcePermissions(
    resource,
    "*",
    !!(canReadGlobal || canUpdateGlobal),
  );
  const inherited = organizationPolicy.data?.grants ?? [];
  // Only offer the way in when the viewer could actually save there. The
  // organization-wide policy reports what this viewer may do with it.
  const canEditAll = !!canUpdateGlobal;
  // The author gets Full access to what they create, so every preset up to it
  // can be handed on. Anything above it (the MCP registry's deployment
  // access) the author can only grant if they already hold it everywhere.
  const presets = resourcePermissionPresetsFor(resource);
  const { data: capabilities } = useScopedCapabilities();
  const canGrantPreset = (actions: readonly string[]) =>
    actions.every(
      (action) =>
        (
          resourcePermissionPresets.manage.actions as readonly string[]
        ).includes(action) ||
        !!capabilities?.some(
          (grant) =>
            grant.resource === resource &&
            grant.action === action &&
            grant.scope === "*",
        ),
    );
  const levelOptions = Object.entries(presets).map(([value, preset]) => ({
    value,
    label: preset.label,
    description: presetDescription(value, resource),
    disabled: !canGrantPreset(preset.actions),
  }));
  const description = permissionsSettingsDescription(
    scopedResourceNouns[resource],
  );
  const addAccessButton = (
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
  );
  const accessRows = (
    <>
      {/* A rule above the list only. The section that follows draws its own
          top rule, so closing this one too stacks two lines. */}
      {(ownerName || grants.length > 0 || inherited.length > 0) && (
        <div className="divide-y border-t">
          {ownerName && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <UserRound
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="min-w-40 flex-1 truncate">
                {ownerName}
                <span className="ml-2 text-xs text-muted-foreground">
                  Owner
                </span>
              </span>
              {/* Same width and padding as the editable rows' permission
                  select, plus the trash column's spacer, so every row in the
                  list shares one permission column. */}
              <span className="w-48 shrink-0 px-3 text-sm text-muted-foreground">
                Full access
              </span>
              <span className="size-8 shrink-0" />
            </div>
          )}
          {grants.map((grant, index) => (
            <div
              key={`${grant.subject.type}:${grant.subject.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
            >
              <SubjectIcon type={grant.subject.type} />
              <div className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-sm font-medium">
                  {grant.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {subjectLabels[grant.subject.type]}
                </span>
              </div>
              <PermissionLevelSelect
                value={presetFor(grant.actions, resource)}
                onValueChange={(value) => {
                  const preset = presets[value];
                  if (!preset) return;
                  onChange(
                    grants.map((entry, entryIndex) =>
                      entryIndex === index
                        ? { ...entry, actions: [...preset.actions] }
                        : entry,
                    ),
                  );
                }}
                options={levelOptions}
                ariaLabel={`Permission for ${grant.name}`}
                className="border-transparent bg-transparent shadow-none dark:bg-transparent"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground"
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
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-muted-foreground"
            >
              <SubjectIcon type={grant.subject.type} />
              <div className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="break-words text-sm font-medium">
                  {grant.name}
                </span>
                <span className="text-xs">
                  {subjectLabels[grant.subject.type]}
                </span>
                {/* The source of the access carries its own affordance, so it
                    does not read as a continuation of the subject label. */}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="font-normal text-muted-foreground"
                      aria-label={`Why ${grant.name} has access: every ${scopedResourceNouns[resource]}`}
                    >
                      <span>Every {scopedResourceNouns[resource]}</span>
                      <Info className="size-3" aria-hidden="true" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-72 max-w-[calc(100vw-2rem)] px-3 py-2 text-xs leading-relaxed"
                    aria-label={`Access source for ${grant.name}`}
                  >
                    <p>
                      <span>
                        Applies to every {scopedResourceNouns[resource]},
                        including this one once it is created.
                      </span>
                      {canEditAll && (
                        <>
                          {" Edit in "}
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0 text-xs underline underline-offset-2"
                            onClick={() => setAllPermissionsOpen(true)}
                          >
                            permissions for all {resourcePluralNames[resource]}
                          </Button>
                          .
                        </>
                      )}
                    </p>
                  </PopoverContent>
                </Popover>
              </div>
              <span className="w-48 shrink-0 px-3 text-sm text-muted-foreground">
                {actionSummary(grant.actions, resource)}
              </span>
              <span className="size-8 shrink-0" />
            </div>
          ))}
        </div>
      )}
    </>
  );
  return (
    <>
      {layout === "settings" ? (
        <PermissionsSettingsSection
          resourceName={scopedResourceNouns[resource]}
          directCount={grants.length}
          inheritedCount={inherited.length}
          action={addAccessButton}
        >
          {accessRows}
        </PermissionsSettingsSection>
      ) : (
        <PermissionsPanel embedded standalone={standalone}>
          <div
            className={
              !showHeader
                ? "flex justify-end"
                : "flex items-start justify-between gap-3"
            }
          >
            {showHeader && (
              <div className="min-w-0">
                <h3 className="text-sm font-medium">Permissions</h3>
                <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                  {description}
                </p>
              </div>
            )}
            {addAccessButton}
          </div>
          {accessRows}
        </PermissionsPanel>
      )}
      {allPermissionsOpen && (
        <ResourcePermissionsDialog
          resource={resource}
          open={allPermissionsOpen}
          onOpenChange={setAllPermissionsOpen}
        />
      )}
      <AddResourceAccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        resource={resource}
        scope={scope}
        existingSubjects={grants.map((grant) => grant.subject)}
        presets={Object.entries(presets).map(([value, preset]) => ({
          value,
          label: preset.label,
          description: presetDescription(value, resource),
          actions: [...preset.actions],
          disabled: !canGrantPreset(preset.actions),
        }))}
        onAdd={(added) => {
          onChange([...grants, ...added]);
        }}
      />
    </>
  );
}
