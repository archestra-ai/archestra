// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  type ScopedResource,
  ScopedResourceSchema,
  TEAM_RESOURCE_SCOPE,
} from "@archestra/shared";
import { useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { ResourcePermissions } from "@/components/resource-permissions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const [resource, setResource] = useState<ScopedResource>("agent");
  const [reach, setReach] = useState<Reach>("*");
  return (
    <PageLayout
      title="Permissions"
      description="Access that applies to every object of a resource type, or to the objects each recipient's teams already reach. Access to one object is set on that object's own Permissions tab."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={resource}
            onValueChange={(value) => setResource(value as ScopedResource)}
          >
            <SelectTrigger size="sm" aria-label="Resource type">
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
          <Tabs
            value={reach}
            onValueChange={(value) => setReach(value as Reach)}
          >
            <TabsList>
              <TabsTrigger value="*">Every object</TabsTrigger>
              <TabsTrigger value={TEAM_RESOURCE_SCOPE}>
                Objects their teams reach
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <ResourcePermissions
          key={`${resource}:${reach}`}
          resource={resource}
          scope={reach}
        />
      </div>
    </PageLayout>
  );
}

type Reach = "*" | typeof TEAM_RESOURCE_SCOPE;

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
  scheduledTask: "Scheduled tasks",
  log: "LLM and MCP logs",
  auditLog: "Audit log",
};
