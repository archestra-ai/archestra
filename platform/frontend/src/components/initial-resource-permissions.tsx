// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  grantsAudience,
  type ResourcePermissionGrant,
  resourcePermissionPresets,
  resourcePermissionPresetsFor,
  type ScopedResource,
} from "@archestra/shared";
import { X } from "lucide-react";
import { AccessAudienceHeader } from "@/components/audience-chip";
import { PermissionLevelSelect } from "@/components/permission-level-select";
import { PermissionsSettingsSection } from "@/components/permissions-settings-section";
import {
  defaultAddedPreset,
  ResourceAccessAddField,
} from "@/components/resource-access-add-field";
import {
  InheritedAccessNote,
  PermissionsPanel,
  presetDescription,
  presetFor,
  subjectLabels,
  YouPill,
} from "@/components/resource-permissions";
import { Button } from "@/components/ui/button";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { useResourcePermissions } from "@/lib/resource-permissions.query";

export type InitialPermissionGrant = ResourcePermissionGrant & { name: string };

/** Controlled fields: the owning wizard submits these with the resource. */
export function InitialResourcePermissions({
  resource,
  scope,
  grants,
  onChange,
  standalone,
  layout = "default",
  showAudience = true,
}: {
  resource: ScopedResource;
  scope?: string;
  grants: InitialPermissionGrant[];
  onChange: (grants: InitialPermissionGrant[]) => void;
  /** Set when the section is a tab pane of its own, not one field among many. */
  standalone?: boolean;
  /** Match the title-left, controls-right layout of settings forms. */
  layout?: "default" | "settings";
  /**
   * Off where the grants are additions to objects that already have their
   * own, so they say nothing about the result's audience.
   */
  showAudience?: boolean;
}) {
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
    actions: preset.actions,
    disabled: !canGrantPreset(preset.actions),
  }));
  const audience = grantsAudience(grants);
  // The author gets a Full access grant when the object is created, so the
  // form lists it the way the object's own policy will. Bulk additions to
  // existing objects create nothing, so they have no author row.
  const { data: session } = useSession();
  const author = showAudience ? session?.user : undefined;
  // Organization-wide grants reach this object the moment it exists, so the
  // create form names them the way the edit form does.
  const { data: canReadGlobal } = useHasPermissions({
    accessPolicies: ["read"],
  });
  const organizationPolicy = useResourcePermissions(
    resource,
    "*",
    !!canReadGlobal,
  );
  const grantList = (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border bg-card text-[13px]">
      {author && (
        <div
          data-testid="author-grant"
          className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-2.5"
        >
          <div className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2">
            <span className="break-words font-medium">
              {author.name || author.email}
            </span>
            <span className="text-xs text-muted-foreground">
              {subjectLabels.user}
            </span>
            <YouPill />
          </div>
          {/* Lines up with the editable rows' level, beside the remove column. */}
          <span className="px-2 text-muted-foreground">
            {resourcePermissionPresets.manage.label}
          </span>
          <span className="size-7 shrink-0" />
        </div>
      )}
      {grants.map((grant, index) => (
        <div
          key={`${grant.subject.type}:${grant.subject.id}`}
          className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-2.5"
        >
          <div className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2">
            <span className="break-words font-medium">{grant.name}</span>
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
            inline
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={`Remove access for ${grant.name}`}
            onClick={() =>
              onChange(grants.filter((_, entryIndex) => entryIndex !== index))
            }
          >
            <X className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="p-1.5">
        <ResourceAccessAddField
          resource={resource}
          scope={scope}
          existingSubjects={[
            ...grants.map((grant) => grant.subject),
            ...(author ? [{ type: "user" as const, id: author.id }] : []),
          ]}
          onPick={(recipient) => {
            const preset = defaultAddedPreset(levelOptions);
            if (preset)
              onChange([
                ...grants,
                { ...recipient, actions: [...preset.actions] },
              ]);
          }}
        />
      </div>
    </div>
  );
  const accessRows = (
    <>
      {grantList}
      <InheritedAccessNote
        resource={resource}
        grants={organizationPolicy.data?.grants ?? []}
      />
    </>
  );
  return (
    <>
      {layout === "settings" ? (
        <PermissionsSettingsSection audience={showAudience ? audience : null}>
          {accessRows}
        </PermissionsSettingsSection>
      ) : (
        <PermissionsPanel embedded standalone={standalone}>
          {showAudience && <AccessAudienceHeader audience={audience} />}
          {accessRows}
        </PermissionsPanel>
      )}
    </>
  );
}
