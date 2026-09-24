"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import type { InitialPermissionGrant } from "@/components/initial-resource-permissions";
import {
  GatewayGrantField,
  OAUTH_CLIENT_SECTIONS,
  type OAuthClientSection,
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import {
  type ProviderApiKeyMap,
  providerApiKeyMapToArray,
} from "@/components/provider-key-mappings-field";
import { ProviderKeyAccessFields } from "@/components/proxy-auth-provider-key-fields";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type OAuthClientType = "mcp" | "llm";

// The two client kinds live in different tables with different payloads, so
// the dialog hands the page a discriminated submit instead of one merged body.
export type CreateOAuthClientSubmit =
  | { kind: "mcp"; body: archestraApiTypes.CreateMcpOauthClientData["body"] }
  | { kind: "llm"; body: archestraApiTypes.CreateLlmOauthClientData["body"] };

export function CreateOAuthClientDialog({
  open,
  onOpenChange,
  defaultClientType = "mcp",
  fixedClientType,
  defaultAllowedGatewayIds,
  gateways,
  providerApiKeys,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultClientType?: OAuthClientType;
  /** Restricts resource-scoped dialogs to the kind managed by that surface. */
  fixedClientType?: OAuthClientType;
  /** Pre-selected allowed gateways/agents (deep link from a connect dialog). */
  defaultAllowedGatewayIds?: string[];
  gateways: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  onSubmit: (values: CreateOAuthClientSubmit) => Promise<void>;
  isSubmitting: boolean;
}) {
  const [clientType, setClientType] =
    useState<OAuthClientType>(defaultClientType);
  const [name, setName] = useState("");
  const [grantType, setGrantType] = useState<GrantType>("client_credentials");
  const [selectedGatewayIds, setSelectedGatewayIds] = useState<string[]>([]);
  const [providerApiKeyIds, setProviderApiKeyIds] = useState<ProviderApiKeyMap>(
    {},
  );
  const [redirectUrisText, setRedirectUrisText] = useState("");
  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [activeSection, setActiveSection] =
    useState<OAuthClientSection>("general");

  useEffect(() => {
    if (open) {
      setActiveSection("general");
      setClientType(fixedClientType ?? defaultClientType);
      setName("");
      setGrantType("client_credentials");
      setSelectedGatewayIds(defaultAllowedGatewayIds ?? []);
      setProviderApiKeyIds({});
      setRedirectUrisText("");
      setInitialGrants([]);
      setLabels([]);
    }
  }, [open, fixedClientType, defaultClientType, defaultAllowedGatewayIds]);

  const isMcp = clientType === "mcp";
  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : isMcp
        ? selectedGatewayIds.length > 0
        : mappedProviderApiKeys.length > 0);

  return (
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description={describeClientType(fixedClientType)}
      sidebarLabel={name.trim() || "New OAuth client"}
      sidebarDescription={isMcp ? "Agents & MCP gateways" : "LLM Proxy"}
      sidebarIcon={<KeyRound className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={OAUTH_CLIENT_SECTIONS}
      onActiveSectionChange={setActiveSection}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || isSubmitting}>
            Create OAuth Client
          </Button>
        </>
      }
      onSubmit={async (event) => {
        event.preventDefault();
        const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
        const shared = {
          name: name.trim(),
          grantType,
          initialGrants: initialGrants.map(
            ({ name: _name, ...grant }) => grant,
          ),
          labels: finalLabels,
        };
        if (isMcp) {
          await onSubmit({
            kind: "mcp",
            body: {
              ...shared,
              allowedGatewayIds: selectedGatewayIds,
              ...(isAuthorizationCode && { redirectUris }),
            },
          });
        } else {
          await onSubmit({
            kind: "llm",
            body: {
              ...shared,
              ...(isAuthorizationCode
                ? { redirectUris }
                : { providerApiKeys: mappedProviderApiKeys }),
            },
          });
        }
      }}
    >
      <div hidden={activeSection !== "general"} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="oauth-client-name">Name</Label>
          <Input
            id="oauth-client-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="support-assistant-prod"
          />
        </div>
        {!fixedClientType && (
          <SelectField
            id="oauth-client-type"
            label="What will this client access?"
            options={CLIENT_TYPE_OPTIONS}
            value={clientType}
            onChange={(next) => {
              setClientType(next as OAuthClientType);
              // The two kinds are separate permission namespaces, so a
              // grant chosen under one type means nothing under the other.
              setInitialGrants([]);
            }}
          />
        )}

        <SelectField
          id="oauth-client-grant-type"
          label="Grant type"
          options={isMcp ? MCP_GRANT_TYPE_OPTIONS : LLM_GRANT_TYPE_OPTIONS}
          value={grantType}
          onChange={(next) => setGrantType(next as GrantType)}
        />

        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>

      <div hidden={activeSection !== "access"} className="space-y-4">
        {isMcp ? (
          isAuthorizationCode ? (
            <>
              <RedirectUrisField
                value={redirectUrisText}
                onChange={setRedirectUrisText}
              />
              <GatewayGrantField
                gateways={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
              />
            </>
          ) : (
            <div className="space-y-2">
              <Label>Allowed gateways &amp; agents</Label>
              <AgentSelector
                mode="multiple"
                agents={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
                placeholder="Select gateways or agents"
                searchPlaceholder="Search gateways and agents"
                emptyMessage="No gateways or agents found"
              />
            </div>
          )
        ) : isAuthorizationCode ? (
          <RedirectUrisField
            value={redirectUrisText}
            onChange={setRedirectUrisText}
          />
        ) : (
          <ProviderKeyAccessFields
            providerApiKeyIds={providerApiKeyIds}
            onProviderApiKeyIdsChange={setProviderApiKeyIds}
            providerApiKeys={providerApiKeys}
          />
        )}
      </div>

      <div hidden={activeSection !== "permissions"}>
        {/* SPDX-SnippetBegin
              SPDX-SnippetCopyrightText: 2026 Archestra Inc.
              SPDX-License-Identifier: LicenseRef-Archestra-Enterprise */}
        <ResourceAccessSection
          resource={isMcp ? "mcpOauthClient" : "llmOauthClient"}
          grants={initialGrants}
          onGrantsChange={setInitialGrants}
          standalone
        />
        {/* SPDX-SnippetEnd */}
      </div>
    </TabbedDialogShell>
  );
}

// ===
// Internal helpers
// ===

type GrantType =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number]["grantType"];

type SelectFieldOption = {
  value: string;
  label: string;
  description: string;
};

/**
 * Names only the surface this dialog can actually register for. Opened from
 * the LLM Proxy or from MCP, the type is fixed and its picker hidden — so
 * listing all three reads as a menu the reader has not been given.
 */
function describeClientType(fixedClientType?: OAuthClientType) {
  if (fixedClientType === "llm") {
    return "Register an application that authenticates to the LLM Proxy with OAuth.";
  }
  if (fixedClientType === "mcp") {
    return "Register an application that authenticates to your MCP gateways and agents with OAuth.";
  }
  return "Register an application that authenticates to your agents, MCP gateways, or the LLM Proxy with OAuth.";
}

const CLIENT_TYPE_OPTIONS: SelectFieldOption[] = [
  {
    value: "mcp",
    label: "Agents & MCP gateways",
    description:
      "For applications that call your A2A agents or use MCP tools through a gateway.",
  },
  {
    value: "llm",
    label: "LLM Proxy",
    description:
      "For applications that send LLM requests through the LLM Proxy.",
  },
];

const MCP_GRANT_TYPE_OPTIONS: SelectFieldOption[] = [
  {
    value: "client_credentials",
    label: "Application (client credentials)",
    description:
      "A backend service or bot calls gateways or agents as itself, with no acting user. Scope it to specific gateways or agents.",
  },
  {
    value: "authorization_code",
    label: "On behalf of users (authorization code)",
    description:
      "A pre-registered app obtains user-scoped tokens, so gateway tools resolve each user's own identity and connections.",
  },
];

const LLM_GRANT_TYPE_OPTIONS: SelectFieldOption[] = [
  {
    value: "client_credentials",
    label: "Application (client credentials)",
    description:
      "A backend service or bot calls the proxy as itself, with no acting user, using provider keys you map to it.",
  },
  {
    value: "authorization_code",
    label: "On behalf of users (authorization code)",
    description:
      "A pre-registered app obtains user-scoped tokens, so the proxy resolves each user's own provider keys, cost limits, and policies.",
  },
];

function SelectField({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: SelectFieldOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              description={option.description}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
