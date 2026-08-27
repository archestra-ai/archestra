"use client";

import type {
  archestraApiTypes,
  ResourceVisibilityScope,
} from "@archestra/shared";
import { useEffect, useState } from "react";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { FormDialog } from "@/components/form-dialog";
import {
  GatewayGrantField,
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import { OauthClientVisibilityField } from "@/components/oauth-client-visibility-field";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
  const [scope, setScope] = useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setClientType(fixedClientType ?? defaultClientType);
      setName("");
      setGrantType("client_credentials");
      setSelectedGatewayIds(defaultAllowedGatewayIds ?? []);
      setProviderApiKeyIds({});
      setRedirectUrisText("");
      setScope("personal");
      setTeamIds([]);
    }
  }, [open, fixedClientType, defaultClientType, defaultAllowedGatewayIds]);

  const isMcp = clientType === "mcp";
  const mappedProviderApiKeys = providerApiKeyMapToArray(providerApiKeyIds);
  const redirectUris = parseRedirectUris(redirectUrisText);
  const isAuthorizationCode = grantType === "authorization_code";
  const canSubmit =
    name.trim().length > 0 &&
    (scope !== "team" || teamIds.length > 0) &&
    (isAuthorizationCode
      ? redirectUris.length > 0
      : isMcp
        ? selectedGatewayIds.length > 0
        : mappedProviderApiKeys.length > 0);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create OAuth Client"
      description={describeClientType(fixedClientType)}
    >
      <DialogForm
        onSubmit={async (event) => {
          event.preventDefault();
          const shared = {
            name: name.trim(),
            grantType,
            scope,
            teams: scope === "team" ? teamIds : [],
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
        <DialogBody className="space-y-4">
          {!fixedClientType && (
            <RadioCardField
              label="What will this client access?"
              options={CLIENT_TYPE_OPTIONS}
              value={clientType}
              onChange={(next) => {
                setClientType(next as OAuthClientType);
                // Visibility permissions are per-resource (mcpOauthClient vs
                // llmOauthClient), so a scope picked under one type may be
                // forbidden under the other.
                setScope("personal");
                setTeamIds([]);
              }}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="oauth-client-name">Name</Label>
            <Input
              id="oauth-client-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="support-assistant-prod"
            />
          </div>

          <RadioCardField
            label="Grant type"
            options={isMcp ? MCP_GRANT_TYPE_OPTIONS : LLM_GRANT_TYPE_OPTIONS}
            value={grantType}
            onChange={(next) => setGrantType(next as GrantType)}
          />

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

          <OauthClientVisibilityField
            resource={isMcp ? "mcpOauthClient" : "llmOauthClient"}
            scope={scope}
            onScopeChange={setScope}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />
        </DialogBody>
        <DialogStickyFooter>
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
        </DialogStickyFooter>
      </DialogForm>
    </FormDialog>
  );
}

// ===
// Internal helpers
// ===

type GrantType =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number]["grantType"];

type RadioCardOption = {
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

const CLIENT_TYPE_OPTIONS: RadioCardOption[] = [
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

const MCP_GRANT_TYPE_OPTIONS: RadioCardOption[] = [
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

const LLM_GRANT_TYPE_OPTIONS: RadioCardOption[] = [
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

function RadioCardField({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: RadioCardOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <RadioGroup value={value} onValueChange={onChange} className="gap-2">
        {options.map((option) => (
          <Label
            key={option.value}
            htmlFor={`radio-card-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 font-normal has-[:checked]:border-primary"
          >
            <RadioGroupItem
              id={`radio-card-${option.value}`}
              value={option.value}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <div className="font-medium">{option.label}</div>
              <p className="text-sm text-muted-foreground">
                {option.description}
              </p>
            </div>
          </Label>
        ))}
      </RadioGroup>
    </div>
  );
}
