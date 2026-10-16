"use client";
import type { archestraApiTypes } from "@archestra/shared";
import type { OAuthClientScope } from "@archestra/shared/oauth";
import { useMutation } from "@tanstack/react-query";
import { Bot, Network, Workflow } from "lucide-react";
import { type UseFormReturn, useWatch } from "react-hook-form";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import {
  BudgetFields,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import { ProviderKeyList } from "@/components/credential-billing/provider-key-list";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { GatewayPicker } from "@/components/oauth-client/gateway-picker";
import { OAuthServiceAccountField } from "@/components/oauth-client/service-account-field";
import { RedirectUrisField } from "@/components/oauth-client-form-fields";
import { ProviderAccessField } from "@/components/provider-access-field";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { fetchAgentOptionIds } from "@/lib/agent-options.query";
import { useScopedCapabilities } from "@/lib/auth/auth.query";

export type OAuthClientFormValues =
  archestraApiTypes.CreateOauthClientData["body"] & {
    redirectUrisText: string;
  };
export const oauthCapabilities = [
  {
    scope: "mcp",
    label: "MCP Gateway",
    description: "Use tools through the gateways you select.",
    icon: Network,
  },
  {
    scope: "a2a",
    label: "A2A",
    description: "Call the agents you select.",
    icon: Workflow,
  },
  {
    scope: "llm:proxy",
    label: "LLM Proxy",
    description: "Send inference requests through provider keys.",
    icon: Bot,
  },
] as const;

export function OAuthClientScopePicker({
  value,
  onChange,
  disabled,
}: {
  disabled?: boolean;
  value: OAuthClientScope[];
  onChange: (value: OAuthClientScope[]) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">What can it access?</legend>
      <p className="text-xs text-muted-foreground">
        Select every capability this application needs.
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {oauthCapabilities.map(({ scope, label, description, icon: Icon }) => (
          <Label
            key={scope}
            htmlFor={`oauth-scope-${scope}`}
            className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
          >
            <Checkbox
              id={`oauth-scope-${scope}`}
              disabled={disabled}
              checked={value.includes(scope)}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...value, scope]
                    : value.filter((item) => item !== scope),
                )
              }
              className="mt-0.5"
            />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 font-medium">
                <Icon className="size-4" />
                <span>{label}</span>
              </span>
              <span className="block text-xs text-muted-foreground leading-relaxed">
                {description}
              </span>
            </span>
          </Label>
        ))}
      </div>
    </fieldset>
  );
}

export function OAuthClientAccessFields({
  form,
  gateways,
  remoteGateways = false,
  providerApiKeys,
  showServiceAccount = true,
  providerAccessSurface = "edit",
}: {
  form: UseFormReturn<OAuthClientFormValues>;
  gateways: AgentSelectorAgent[];
  remoteGateways?: boolean;
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  showServiceAccount?: boolean;
  providerAccessSurface?: "create" | "edit";
}) {
  const values = useWatch({
    control: form.control,
    compute: (current) => current,
  });
  const userMode = values.grantType === "authorization_code";
  const targets = gateways.filter(
    (agent) =>
      values.scopes.includes("mcp") ||
      (agent.agentType === "agent" && values.scopes.includes("a2a")),
  );
  return (
    <div className="space-y-5">
      {showServiceAccount && !userMode && (
        <OAuthServiceAccountField
          clientType={
            values.scopes.includes("mcp") || values.scopes.includes("a2a")
              ? "mcp"
              : "llm"
          }
          value={values.serviceAccountId ?? null}
          onChange={(serviceAccountId) =>
            form.setValue("serviceAccountId", serviceAccountId, {
              shouldDirty: true,
            })
          }
        />
      )}
      {userMode && (
        <RedirectUrisField
          value={values.redirectUrisText}
          onChange={(value) =>
            form.setValue("redirectUrisText", value, { shouldDirty: true })
          }
        />
      )}
      {values.scopes.some((scope) => scope === "mcp" || scope === "a2a") && (
        <GatewayPicker
          label={
            userMode
              ? "Additional gateways and agents (optional)"
              : "Gateways and agents"
          }
          description={
            userMode
              ? "Users keep their own access. Selected targets are added for every user."
              : undefined
          }
          gateways={targets}
          remoteFilters={
            remoteGateways
              ? {
                  agentTypes: values.scopes.includes("mcp")
                    ? ["mcp_gateway", "agent"]
                    : ["agent"],
                }
              : undefined
          }
          value={values.allowedGatewayIds ?? []}
          onValueChange={(value) =>
            form.setValue("allowedGatewayIds", value, { shouldDirty: true })
          }
        />
      )}
      <OAuthClientProviderAccessFields
        form={form}
        providerApiKeys={providerApiKeys}
        providerAccessSurface={providerAccessSurface}
      />
    </div>
  );
}

export function OAuthClientAdvancedFields({
  form,
}: {
  form: UseFormReturn<OAuthClientFormValues>;
}) {
  const values = useWatch({
    control: form.control,
    compute: (current) => current,
  });
  const userMode = values.grantType === "authorization_code";

  return (
    <div className="space-y-5">
      {!userMode && (
        <OAuthServiceAccountField
          clientType={
            values.scopes.includes("mcp") || values.scopes.includes("a2a")
              ? "mcp"
              : "llm"
          }
          value={values.serviceAccountId ?? null}
          onChange={(serviceAccountId) =>
            form.setValue("serviceAccountId", serviceAccountId, {
              shouldDirty: true,
            })
          }
        />
      )}
      {values.scopes.includes("llm:proxy") && (
        <section aria-label="Budget" className="space-y-4">
          <h3 className="font-medium text-sm">Budget</h3>
          {userMode && <UsersPayNotice />}
          <BudgetFields
            layout="plain"
            subject="client"
            idPrefix="oauth-client-budget"
            showBillingTeam={!userMode}
            billingTeamId={values.billingTeamId ?? null}
            onBillingTeamIdChange={(value) =>
              form.setValue("billingTeamId", value, { shouldDirty: true })
            }
            spendCap={values.spendCap ?? null}
            onSpendCapChange={(value) =>
              form.setValue("spendCap", value, { shouldDirty: true })
            }
          />
        </section>
      )}
    </div>
  );
}

export function oauthClientFormBody(
  values: OAuthClientFormValues,
  gateways: AgentSelectorAgent[],
): archestraApiTypes.CreateOauthClientData["body"] {
  const allowed = new Set(
    gateways
      .filter(
        (agent) =>
          values.scopes.includes("mcp") ||
          (agent.agentType === "agent" && values.scopes.includes("a2a")),
      )
      .map((agent) => agent.id),
  );
  return {
    name: values.name.trim(),
    grantType: values.grantType,
    scopes: values.scopes,
    includeFutureProviders:
      values.grantType === "client_credentials" &&
      values.scopes.includes("llm:proxy") &&
      !!values.includeFutureProviders,
    allowedGatewayIds: (values.allowedGatewayIds ?? []).filter(
      (id) =>
        values.scopes.some((scope) => scope === "mcp" || scope === "a2a") &&
        (!gateways.some((agent) => agent.id === id) || allowed.has(id)),
    ),
    ...(values.grantType === "authorization_code"
      ? {
          redirectUris: values.redirectUrisText
            .split(/\r?\n/)
            .map((uri) => uri.trim())
            .filter(Boolean),
        }
      : {
          providerApiKeys: values.providerApiKeys,
          billingTeamId: values.billingTeamId,
          serviceAccountId: values.serviceAccountId,
        }),
    labels: values.labels,
    initialGrants: values.initialGrants,
    spendCap: values.spendCap,
  };
}

/** Scope changes need only IDs to remove gateway targets from an A2A-only grant. */
export async function resolveOauthClientFormBody(
  values: OAuthClientFormValues,
  gateways?: AgentSelectorAgent[],
) {
  const body = oauthClientFormBody(values, gateways ?? []);
  if (
    gateways === undefined &&
    values.scopes.includes("a2a") &&
    !values.scopes.includes("mcp") &&
    body.allowedGatewayIds?.length
  ) {
    const gatewaysOnly = new Set(
      await fetchAgentOptionIds({ agentTypes: ["mcp_gateway"] }),
    );
    body.allowedGatewayIds = body.allowedGatewayIds.filter(
      (id) => !gatewaysOnly.has(id),
    );
  }
  return body;
}

export function useOauthClientScopeChange(
  form: UseFormReturn<OAuthClientFormValues>,
  gateways?: AgentSelectorAgent[],
) {
  const mutation = useMutation({
    mutationFn: (scopes: OAuthClientScope[]) =>
      resolveOauthClientFormBody({ ...form.getValues(), scopes }, gateways),
    onSuccess: (body) => {
      form.setValue("scopes", body.scopes, { shouldDirty: true });
      form.setValue("allowedGatewayIds", body.allowedGatewayIds ?? [], {
        shouldDirty: true,
      });
    },
  });
  return { change: mutation.mutate, isPending: mutation.isPending };
}

export function oauthClientFormReady(values: OAuthClientFormValues): boolean {
  if (!values.name.trim() || !values.scopes.length) return false;
  if (values.grantType === "authorization_code")
    return values.redirectUrisText.trim().length > 0;
  return (
    (!values.scopes.includes("llm:proxy") ||
      !!values.includeFutureProviders ||
      !!values.providerApiKeys?.length) &&
    (!values.scopes.some((scope) => scope === "mcp" || scope === "a2a") ||
      !!values.allowedGatewayIds?.length)
  );
}

function OAuthClientProviderAccessFields({
  form,
  providerApiKeys,
  providerAccessSurface = "edit",
}: {
  form: UseFormReturn<OAuthClientFormValues>;
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
  providerAccessSurface?: "create" | "edit";
}) {
  const values = useWatch({
    control: form.control,
    compute: (current) => current,
  });
  const userMode = values.grantType === "authorization_code";
  const llm = values.scopes.includes("llm:proxy");
  const { data: capabilities } = useScopedCapabilities(!userMode && llm);
  const includeFutureProviders = values.includeFutureProviders ?? false;
  const canIncludeFutureProviders =
    capabilities?.some(
      (grant) =>
        grant.resource === "llmProviderApiKey" &&
        grant.action === "use" &&
        grant.scope === "*",
    ) ?? false;

  if (!llm) return null;
  if (userMode) {
    return (
      <section aria-label="LLM provider access" className="space-y-2">
        <Label>LLM provider access</Label>
        <p className="text-sm text-muted-foreground">
          <span>Each signed-in user's own provider keys and limits apply.</span>
        </p>
      </section>
    );
  }

  return (
    <ProviderAccessField
      surface={providerAccessSurface}
      credentialLabel="OAuth client"
      label="LLM provider access"
      apiKeysLabel="LLM API keys"
      canIncludeFutureProviders={
        canIncludeFutureProviders ||
        (providerAccessSurface === "edit" && includeFutureProviders)
      }
      includeFutureProviders={includeFutureProviders}
      onIncludeFutureProvidersChange={(value) => {
        form.setValue("includeFutureProviders", value, { shouldDirty: true });
        if (value) {
          form.setValue("providerApiKeys", [], { shouldDirty: true });
        }
      }}
      current={
        <ProviderKeyList
          alwaysOpen
          label="LLM API keys"
          showLabel={!includeFutureProviders}
          allowBulkAdd={!includeFutureProviders}
          emptyLabel={
            includeFutureProviders
              ? "Uses primary API keys — add a provider to choose a different key"
              : "No providers selected — add one below"
          }
          value={values.providerApiKeys ?? []}
          onChange={(value) =>
            form.setValue("providerApiKeys", value, { shouldDirty: true })
          }
          providerApiKeys={providerApiKeys as LlmProviderApiKeyResponse[]}
        />
      }
    />
  );
}
