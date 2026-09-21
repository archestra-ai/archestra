// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  ORGANIZATION_WIDE_RESOURCES,
  type ScopedResource,
  ScopedResourceSchema,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ResourcePermissions } from "@/components/resource-permissions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
} from "@/components/unsaved-changes-guard";

/**
 * Access that applies to a whole resource type, kept apart from the pages that
 * hand out roles.
 *
 * A role says what someone may do; a grant says which objects they may do it
 * to. Mixing the two into one screen is what made the old model hard to
 * answer questions about, so role, team and service-account pages stay pure
 * assignment and every scope decision is made here or on the object itself.
 */
export function OrganizationPermissions() {
  const router = useRouter();
  const [resource, setResource] = useState<ScopedResource>("agent");
  const [dirtyScopes, setDirtyScopes] = useState({ all: false, teams: false });
  const isDirty = dirtyScopes.all || dirtyScopes.teams;
  const [pending, setPending] = useState<
    { resource: ScopedResource } | { href: string } | null
  >(null);
  const setAllDirty = useCallback(
    (all: boolean) => setDirtyScopes((current) => ({ ...current, all })),
    [],
  );
  const setTeamsDirty = useCallback(
    (teams: boolean) => setDirtyScopes((current) => ({ ...current, teams })),
    [],
  );
  useBeforeUnloadWhileDirty(isDirty);
  useGuardedInAppNavigation({
    isDirty,
    onRequestNavigate: useCallback((href: string) => setPending({ href }), []),
  });
  const selectResource = (next: ScopedResource) => {
    if (next === resource) return;
    if (isDirty) setPending({ resource: next });
    else setResource(next);
  };
  const label = RESOURCE_LABELS[resource];
  const plural = /^(MCP|LLM)/.test(label)
    ? label
    : label[0].toLowerCase() + label.slice(1);

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center gap-3 border-b pb-4">
          <Label
            htmlFor="permission-resource"
            className="text-sm text-muted-foreground"
          >
            Manage access to
          </Label>
          <Select
            value={resource}
            onValueChange={(value) => selectResource(value as ScopedResource)}
          >
            <SelectTrigger
              id="permission-resource"
              className="w-auto min-w-40 border-transparent bg-transparent text-base font-semibold shadow-none hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
              aria-label="Resource type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ScopedResourceSchema.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {RESOURCE_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <section aria-label={`All ${plural}`}>
          <ResourcePermissions
            key={`${resource}:all`}
            resource={resource}
            scope="*"
            title={`All ${plural}`}
            onDirtyChange={setAllDirty}
            description={`Access to every ${RESOURCE_SINGULAR[resource]}, including ones created later.`}
          />
        </section>

        {!ORGANIZATION_WIDE_RESOURCES.has(resource) && (
          <section
            aria-label={`${label} shared with their teams`}
            className="border-t pt-6"
          >
            <ResourcePermissions
              key={`${resource}:teams`}
              resource={resource}
              scope={TEAM_RESOURCE_SCOPE}
              title={`${label} shared with their teams`}
              onDirtyChange={setTeamsDirty}
              description={`Access only to ${plural} shared with a team the recipient belongs to.`}
              showInherited={false}
            />
          </section>
        )}
      </div>
      <UnsavedChangesDialog
        open={pending !== null}
        onKeepEditing={() => setPending(null)}
        onDiscard={() => {
          if (!pending) return;
          setDirtyScopes({ all: false, teams: false });
          setPending(null);
          if ("href" in pending) router.push(pending.href);
          else {
            setResource(pending.resource);
          }
        }}
      />
    </>
  );
}

const RESOURCE_LABELS: Record<ScopedResource, string> = {
  agent: "Agents",
  skill: "Skills",
  app: "Apps",
  llmModel: "Models",
  mcpGateway: "MCP gateways",
  mcpRegistry: "MCP registry entries",
  project: "Projects",
  plugin: "Plugins",
  knowledgeBase: "Knowledge bases",
  knowledgeConnector: "Connectors",
  knowledgeFile: "Files",
  llmVirtualKey: "Virtual keys",
  llmProviderApiKey: "Provider keys",
  environment: "Environments",
  scheduledTask: "Scheduled tasks",
  log: "LLM and MCP logs",
  auditLog: "Audit logs",
  serviceAccount: "Service accounts",
};

const RESOURCE_SINGULAR: Record<ScopedResource, string> = {
  agent: "agent",
  skill: "skill",
  app: "app",
  llmModel: "model",
  mcpGateway: "MCP gateway",
  mcpRegistry: "MCP registry entry",
  project: "project",
  plugin: "plugin",
  knowledgeBase: "knowledge base",
  knowledgeConnector: "connector",
  knowledgeFile: "file",
  llmVirtualKey: "virtual key",
  llmProviderApiKey: "provider key",
  environment: "environment",
  scheduledTask: "scheduled task",
  log: "LLM and MCP log",
  auditLog: "audit log entry",
  serviceAccount: "service account",
};
