"use client";
import type { archestraApiTypes } from "@archestra/shared";
import type { OAuthClientScope } from "@archestra/shared/oauth";
import { Bot, Network, Workflow } from "lucide-react";
import type { UseFormReturn } from "react-hook-form";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import { ProviderKeyList } from "@/components/credential-billing/provider-key-list";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { GatewayPicker } from "@/components/oauth-client/gateway-picker";
import { OAuthServiceAccountField } from "@/components/oauth-client/service-account-field";
import { RedirectUrisField } from "@/components/oauth-client-form-fields";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

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
}: {
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
  providerApiKeys,
}: {
  form: UseFormReturn<OAuthClientFormValues>;
  gateways: AgentSelectorAgent[];
  providerApiKeys: archestraApiTypes.GetLlmProviderApiKeysResponses["200"];
}) {
  const values = form.watch();
  const userMode = values.grantType === "authorization_code";
  const targets = gateways.filter(
    (agent) =>
      values.scopes.includes("mcp") ||
      (agent.agentType === "agent" && values.scopes.includes("a2a")),
  );
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
      {userMode && (
        <RedirectUrisField
          value={values.redirectUrisText}
          onChange={(value) =>
            form.setValue("redirectUrisText", value, { shouldDirty: true })
          }
        />
      )}
      {values.scopes.some((scope) => scope === "mcp" || scope === "a2a") && (
        <>
          <p className="text-sm text-muted-foreground">
            <span>
              {userMode
                ? "Signed-in users keep their own access. Selecting gateways or agents adds access for everyone who signs in through this client."
                : "Requests can reach only the gateways and agents selected below."}
            </span>
          </p>
          <GatewayPicker
            label={
              userMode
                ? "Additional gateways and agents (optional)"
                : "Gateways and agents"
            }
            gateways={targets}
            value={values.allowedGatewayIds ?? []}
            onValueChange={(value) =>
              form.setValue("allowedGatewayIds", value, { shouldDirty: true })
            }
          />
        </>
      )}
      {values.scopes.includes("llm:proxy") &&
        (userMode ? (
          <p className="text-sm text-muted-foreground">
            <span>
              Each signed-in user's own provider keys and limits apply.
            </span>
          </p>
        ) : (
          <div className="space-y-2">
            <Label>Provider keys</Label>
            <ProviderKeyList
              alwaysOpen
              value={values.providerApiKeys ?? []}
              onChange={(value) =>
                form.setValue("providerApiKeys", value, { shouldDirty: true })
              }
              providerApiKeys={providerApiKeys as LlmProviderApiKeyResponse[]}
            />
          </div>
        ))}
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

export function oauthClientFormReady(values: OAuthClientFormValues): boolean {
  if (!values.name.trim() || !values.scopes.length) return false;
  if (values.grantType === "authorization_code")
    return values.redirectUrisText.trim().length > 0;
  return (
    (!values.scopes.includes("llm:proxy") ||
      !!values.providerApiKeys?.length) &&
    (!values.scopes.some((scope) => scope === "mcp" || scope === "a2a") ||
      !!values.allowedGatewayIds?.length)
  );
}

export function setOauthClientScopes(
  form: UseFormReturn<OAuthClientFormValues>,
  scopes: OAuthClientScope[],
  gateways: AgentSelectorAgent[],
) {
  const values = form.getValues();
  form.setValue("scopes", scopes, { shouldDirty: true });
  const body = oauthClientFormBody({ ...values, scopes }, gateways);
  form.setValue("allowedGatewayIds", body.allowedGatewayIds ?? [], {
    shouldDirty: true,
  });
}
