"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Bot, Loader2, Network, Server, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentSelectorAgent } from "@/components/agent-selector";
import {
  BudgetFields,
  describeWindow,
  type SpendCapValue,
  UsersPayNotice,
} from "@/components/credential-billing/budget-fields";
import { ProviderKeyPicker } from "@/components/credential-billing/provider-key-picker";
import {
  ReviewList,
  ReviewListRow,
} from "@/components/credential-billing/review-list";
import { WizardSteps } from "@/components/credential-billing/wizard-steps";
import { FormDialog } from "@/components/form-dialog";
import type { LlmProviderApiKeyResponse } from "@/components/llm-provider-api-key-form";
import { ChoiceCards } from "@/components/oauth-client/choice-cards";
import { GatewayPicker } from "@/components/oauth-client/gateway-picker";
import {
  parseRedirectUris,
  RedirectUrisField,
} from "@/components/oauth-client-form-fields";
import type { ProviderApiKeyMappings } from "@/components/provider-key-mappings-field";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useTeams } from "@/lib/teams/team.query";

export type OAuthClientType = "mcp" | "llm";

// The two client kinds live in different tables with different payloads, so
// the dialog hands the page a discriminated submit instead of one merged body.
export type CreateOAuthClientSubmit =
  | { kind: "mcp"; body: archestraApiTypes.CreateMcpOauthClientData["body"] }
  | { kind: "llm"; body: archestraApiTypes.CreateLlmOauthClientData["body"] };

/**
 * Registering an OAuth client, one decision per step: what it reaches and
 * how it signs in, then only the steps that path needs (gateways, provider
 * keys, redirect URIs, budget), then a review.
 */
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
  const [grantsGateways, setGrantsGateways] = useState(false);
  const [providerApiKeyIds, setProviderApiKeyIds] =
    useState<ProviderApiKeyMappings>([]);
  const [redirectUrisText, setRedirectUrisText] = useState("");
  const [billingTeamId, setBillingTeamId] = useState<string | null>(null);
  const [spendCap, setSpendCap] = useState<SpendCapValue>(null);
  const [step, setStep] = useState<Step>("kind");

  useEffect(() => {
    if (open) {
      setStep("kind");
      setClientType(fixedClientType ?? defaultClientType);
      setName("");
      setGrantType("client_credentials");
      setSelectedGatewayIds(defaultAllowedGatewayIds ?? []);
      setGrantsGateways(false);
      setProviderApiKeyIds([]);
      setRedirectUrisText("");
      setBillingTeamId(null);
      setSpendCap(null);
    }
  }, [open, fixedClientType, defaultClientType, defaultAllowedGatewayIds]);

  const isMcp = clientType === "mcp";
  const isAuthorizationCode = grantType === "authorization_code";
  const redirectUris = parseRedirectUris(redirectUrisText);
  const steps = stepsFor({ isMcp, isAuthorizationCode });
  const stepIndex = steps.findIndex((item) => item.id === step);
  const ready: Record<Step, boolean> = {
    kind: name.trim().length > 0,
    signin: redirectUris.length > 0,
    access:
      isAuthorizationCode && !grantsGateways
        ? true
        : selectedGatewayIds.length > 0,
    keys: providerApiKeyIds.length > 0,
    budget: true,
    review: true,
  };
  const canSubmit = steps.every((item) => ready[item.id]) && !isSubmitting;
  // Users who sign in through an authorization-code client keep their own
  // access unless the client explicitly grants gateways on top.
  const grantedGatewayIds =
    isAuthorizationCode && !grantsGateways ? [] : selectedGatewayIds;

  const submit = async () => {
    const shared = {
      name: name.trim(),
      grantType,
      initialGrants: [],
      labels: [],
    };
    if (isMcp) {
      await onSubmit({
        kind: "mcp",
        body: {
          ...shared,
          allowedGatewayIds: grantedGatewayIds,
          ...(isAuthorizationCode && { redirectUris }),
        },
      });
      return;
    }
    await onSubmit({
      kind: "llm",
      body: {
        ...shared,
        ...(isAuthorizationCode
          ? { redirectUris }
          : {
              providerApiKeys: providerApiKeyIds,
              ...(billingTeamId && { billingTeamId }),
            }),
        ...(spendCap && { spendCap }),
      },
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New OAuth client"
      description={describeClientType(fixedClientType)}
      size="small"
      className="sm:max-w-[680px]"
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (step === "review") {
            if (canSubmit) void submit();
            return;
          }
          if (ready[step]) setStep(steps[stepIndex + 1]?.id ?? step);
        }}
      >
        <DialogBody className="space-y-4">
          <WizardSteps
            steps={steps}
            activeStep={step}
            onStepClick={setStep}
            canVisitStep={(next) =>
              steps
                .slice(
                  0,
                  steps.findIndex((item) => item.id === next),
                )
                .every((item) => ready[item.id])
            }
          />

          {step === "kind" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="oauth-client-name">Name</Label>
                <Input
                  id="oauth-client-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="support-assistant-prod"
                />
              </div>
              {!fixedClientType && (
                <ChoiceCards
                  label="What will it reach?"
                  idPrefix="oauth-client-type"
                  value={clientType}
                  onValueChange={(next) => {
                    setClientType(next);
                  }}
                  options={[
                    {
                      value: "mcp",
                      title: "Agents & MCP gateways",
                      description:
                        "Calls your A2A agents or uses MCP tools through a gateway.",
                      icon: <Network className="size-4" />,
                    },
                    {
                      value: "llm",
                      title: "LLM Proxy",
                      description: "Sends LLM requests through the LLM Proxy.",
                      icon: <Bot className="size-4" />,
                    },
                  ]}
                />
              )}
              <ChoiceCards
                label="How does it sign in?"
                idPrefix="oauth-client-grant"
                value={grantType}
                onValueChange={setGrantType}
                options={[
                  {
                    value: "client_credentials",
                    title: "As itself",
                    description: isMcp
                      ? "A service or bot with no user, limited to the gateways you pick."
                      : "A service or bot with no user, using the provider keys you pick.",
                    icon: <Server className="size-4" />,
                  },
                  {
                    value: "authorization_code",
                    title: "For its users",
                    description: isMcp
                      ? "An app signs users in, and tools act with each user's identity."
                      : "An app signs users in, and each user's own keys and limits apply.",
                    icon: <Users className="size-4" />,
                  },
                ]}
              />
            </>
          )}

          {step === "signin" && (
            <RedirectUrisField
              value={redirectUrisText}
              onChange={setRedirectUrisText}
            />
          )}

          {step === "access" &&
            (isAuthorizationCode ? (
              <>
                <ChoiceCards
                  label="What can signed-in users reach?"
                  idPrefix="oauth-client-access"
                  columns={1}
                  value={grantsGateways ? "grant" : "own"}
                  onValueChange={(next) => setGrantsGateways(next === "grant")}
                  options={[
                    {
                      value: "own",
                      title: "Only what each user can already reach",
                      description:
                        "Access stays governed by each user's own role and teams.",
                    },
                    {
                      value: "grant",
                      title: "Also these gateways, for everyone who signs in",
                      description:
                        "Adds the gateways below on top of each user's own access.",
                    },
                  ]}
                />
                {grantsGateways && (
                  <GatewayPicker
                    label="Gateways to grant"
                    gateways={gateways}
                    value={selectedGatewayIds}
                    onValueChange={setSelectedGatewayIds}
                  />
                )}
              </>
            ) : (
              <GatewayPicker
                label="Gateways and agents it can call"
                gateways={gateways}
                value={selectedGatewayIds}
                onValueChange={setSelectedGatewayIds}
              />
            ))}

          {step === "keys" && (
            <div className="space-y-2">
              <span className="font-medium text-sm">Provider keys</span>
              <ProviderKeyPicker
                value={providerApiKeyIds}
                onChange={setProviderApiKeyIds}
                providerApiKeys={providerApiKeys as LlmProviderApiKeyResponse[]}
              />
            </div>
          )}

          {step === "budget" && (
            <>
              {isAuthorizationCode && <UsersPayNotice />}
              <BudgetFields
                subject="client"
                idPrefix="oauth-client"
                showBillingTeam={!isAuthorizationCode}
                billingTeamId={billingTeamId}
                onBillingTeamIdChange={setBillingTeamId}
                spendCap={spendCap}
                onSpendCapChange={setSpendCap}
              />
            </>
          )}

          {step === "review" && (
            <OAuthClientReview
              name={name}
              isMcp={isMcp}
              isAuthorizationCode={isAuthorizationCode}
              redirectUris={redirectUris}
              gatewayNames={grantedGatewayIds.map(
                (id) =>
                  gateways.find((gateway) => gateway.id === id)?.name ?? id,
              )}
              providerApiKeyIds={providerApiKeyIds}
              providerApiKeys={providerApiKeys as LlmProviderApiKeyResponse[]}
              billingTeamId={billingTeamId}
              spendCap={spendCap}
              onEdit={setStep}
            />
          )}
        </DialogBody>
        <DialogStickyFooter className="mt-0">
          {stepIndex > 0 && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => setStep(steps[stepIndex - 1]?.id ?? step)}
            >
              Back
            </Button>
          )}
          <DialogCancelButton>Cancel</DialogCancelButton>
          {step === "review" ? (
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              <span>Create client</span>
            </Button>
          ) : (
            <Button type="submit" disabled={!ready[step]}>
              Continue
            </Button>
          )}
        </DialogStickyFooter>
      </form>
    </FormDialog>
  );
}

// ===
// Internal helpers
// ===

type GrantType =
  archestraApiTypes.GetMcpOauthClientsResponses["200"][number]["grantType"];

type Step = "kind" | "signin" | "access" | "keys" | "budget" | "review";

function stepsFor({
  isMcp,
  isAuthorizationCode,
}: {
  isMcp: boolean;
  isAuthorizationCode: boolean;
}): Array<{ id: Step; title: string }> {
  const kind = { id: "kind" as const, title: "Client" };
  const review = { id: "review" as const, title: "Review" };
  const signin = { id: "signin" as const, title: "Sign-in" };
  if (isMcp) {
    return isAuthorizationCode
      ? [kind, signin, { id: "access", title: "Access" }, review]
      : [kind, { id: "access", title: "Access" }, review];
  }
  return isAuthorizationCode
    ? [kind, signin, { id: "budget", title: "Budget" }, review]
    : [
        kind,
        { id: "keys", title: "Keys" },
        { id: "budget", title: "Budget" },
        review,
      ];
}

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

function OAuthClientReview({
  name,
  isMcp,
  isAuthorizationCode,
  redirectUris,
  gatewayNames,
  providerApiKeyIds,
  providerApiKeys,
  billingTeamId,
  spendCap,
  onEdit,
}: {
  name: string;
  isMcp: boolean;
  isAuthorizationCode: boolean;
  redirectUris: string[];
  gatewayNames: string[];
  providerApiKeyIds: ProviderApiKeyMappings;
  providerApiKeys: LlmProviderApiKeyResponse[];
  billingTeamId: string | null;
  spendCap: SpendCapValue;
  onEdit: (step: Step) => void;
}) {
  const catalog = useModelProviderCatalog();
  const { data: teams = [] } = useTeams({ enabled: !!billingTeamId });
  const teamName = teams.find((team) => team.id === billingTeamId)?.name;
  const keyName = (id: string) =>
    providerApiKeys.find((key) => key.id === id)?.name ?? "Unknown key";

  return (
    <div className="space-y-4">
      <ReviewList>
        <ReviewListRow label="Name" onEdit={() => onEdit("kind")}>
          {name}
        </ReviewListRow>
        <ReviewListRow label="Client" onEdit={() => onEdit("kind")}>
          {isMcp ? "Agents & MCP gateways" : "LLM Proxy"} ·{" "}
          {isAuthorizationCode ? "for its users" : "as itself"}
        </ReviewListRow>
        {isAuthorizationCode && (
          <ReviewListRow label="Redirect URIs" onEdit={() => onEdit("signin")}>
            <span className="break-all">{redirectUris.join(", ")}</span>
          </ReviewListRow>
        )}
        {isMcp && (
          <ReviewListRow label="Gateways" onEdit={() => onEdit("access")}>
            {gatewayNames.length
              ? gatewayNames.join(", ")
              : "Each user's own access"}
          </ReviewListRow>
        )}
        {!isMcp && !isAuthorizationCode && (
          <ReviewListRow label="Provider keys" onEdit={() => onEdit("keys")}>
            <span className="flex flex-wrap gap-1.5">
              {providerApiKeyIds.map((mapping) => (
                <span
                  key={mapping.provider}
                  className="rounded-full border bg-muted px-2 py-0.5 text-xs"
                >
                  {catalog.label(mapping.provider)} ·{" "}
                  {keyName(mapping.providerApiKeyId)}
                </span>
              ))}
            </span>
          </ReviewListRow>
        )}
        {!isMcp && (
          <>
            <ReviewListRow label="Billed to" onEdit={() => onEdit("budget")}>
              {isAuthorizationCode
                ? "Each signed-in user"
                : billingTeamId
                  ? (teamName ?? "A team")
                  : "No team"}
            </ReviewListRow>
            <ReviewListRow label="Spend cap" onEdit={() => onEdit("budget")}>
              {spendCap
                ? `$${spendCap.limitValue.toLocaleString("en-US")} ${describeWindow(spendCap.cleanupInterval)}`
                : "No cap"}
            </ReviewListRow>
          </>
        )}
      </ReviewList>
    </div>
  );
}
