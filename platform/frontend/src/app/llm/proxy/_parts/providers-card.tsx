"use client";

import {
  SUBSCRIPTION_CREDENTIALS,
  type SupportedProvider,
} from "@archestra/shared";
import { useState } from "react";
import { CopilotOrganizationConnectDialog } from "@/app/llm/model-providers/_parts/copilot-organization-connect-dialog";
import {
  buildSubscriptionOffers,
  type SubscriptionOffer,
} from "@/app/llm/model-providers/_parts/subscription-offers";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useModelsWithApiKeys } from "@/lib/llm-models.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  ChipButton,
  ChipLink,
  ChipRow,
  DashboardCard,
  EmptyBox,
  FooterAction,
  FooterLink,
  MoreLink,
  NotSetUpBadge,
  ProviderLogo,
} from "./dashboard-card";

/** Chips shown before "+N more". */
const VISIBLE_PROVIDERS = 10;
/** The providers a new organization is offered first. */
const STARTER_PROVIDERS: SupportedProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "bedrock",
];

/**
 * The providers that have a key, each with how many models it serves; a dot
 * marks one whose key needs reconnecting. A new organization gets the
 * providers to add a key for, and the subscriptions to sign in with.
 */
export function ProvidersCard() {
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const { data: keys = [], isPending } = useLlmProviderApiKeys();
  // The models each key brings, as the Models page lists them: decision
  // models such as Jev's included.
  const { data: models = [] } = useModelsWithApiKeys({ toastOnError: false });
  // A dialog to add a key: for any provider (null) or one chosen here.
  const [adding, setAdding] = useState<SupportedProvider | null | undefined>();
  const [subscription, setSubscription] = useState<SubscriptionOffer | null>(
    null,
  );
  const [copilotOrgOpen, setCopilotOrgOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const providers = [
    ...new Set(
      keys
        .filter((key) => !providerCatalog.isKeyHidden(key))
        .map((key) => key.provider),
    ),
  ];
  const isEmpty = !isPending && providers.length === 0;
  const providerKeysOf = (provider: SupportedProvider) =>
    keys.filter(
      (key) => key.provider === provider && !providerCatalog.isKeyHidden(key),
    );
  const modelCount = (provider: SupportedProvider) => {
    const keyIds = new Set(providerKeysOf(provider).map((key) => key.id));
    return models.filter((model) =>
      model.apiKeys.some((apiKey) => keyIds.has(apiKey.id)),
    ).length;
  };
  // The Models page filters by one provider key: the provider's primary one,
  // or its first.
  const modelsHref = (provider: SupportedProvider) => {
    const providerKeys = providerKeysOf(provider);
    const key =
      providerKeys.find((candidate) => candidate.isPrimary) ?? providerKeys[0];
    return key ? `/llm/models?apiKey=${key.id}` : "/llm/models";
  };
  const needsAttention = (provider: SupportedProvider) =>
    keys.some(
      (key) => key.provider === provider && key.requiresReauthentication,
    );

  const addable = providerCatalog.visibleIds.filter(
    (provider) =>
      providerCatalog.canAddKey(provider) && provider !== "github-copilot",
  );
  const starters = STARTER_PROVIDERS.filter((p) => addable.includes(p));
  const extras = addable.filter((p) => !starters.includes(p));
  const offers = buildSubscriptionOffers(keys);
  const chatgpt = providerCatalog.canAddKey("openai")
    ? offers.find((offer) => offer.kind === "chatgpt")
    : undefined;
  const copilotPersonal = providerCatalog.canAddKey("github-copilot")
    ? offers.find((offer) => offer.kind === "github-copilot")
    : undefined;
  const copilotOrg = !providerCatalog.isCopilotPlanHidden("enterprise");

  return (
    <DashboardCard
      id="llm-proxy-providers"
      title="Providers and models"
      count={providers.length}
      status={isEmpty && <NotSetUpBadge>Not set up</NotSetUpBadge>}
      footer={
        <>
          <FooterAction onClick={() => setAdding(null)}>
            + Add provider API key
          </FooterAction>
          <FooterLink href="/llm/models" className="ml-auto">
            All models
          </FooterLink>
          <FooterLink href="/llm/model-providers">Manage</FooterLink>
        </>
      }
    >
      {isEmpty ? (
        <EmptyBox>
          <span className="text-[13.5px] font-medium">
            Add a provider API key or subscription
          </span>
          <ChipRow>
            {starters.map((provider) => (
              <ChipButton key={provider} onClick={() => setAdding(provider)}>
                <ProviderLogo provider={provider} />
                {providerCatalog.label(provider)}
              </ChipButton>
            ))}
            {extras.length > 0 && (
              <ChipButton
                aria-expanded={showAll}
                onClick={() => setShowAll((open) => !open)}
                className="border-dashed bg-transparent text-primary"
              >
                {showAll ? "Show less" : `+${extras.length} more`}
              </ChipButton>
            )}
          </ChipRow>
          {showAll && (
            <ChipRow>
              {extras.map((provider) => (
                <ChipButton
                  key={provider}
                  onClick={() => setAdding(provider)}
                  className="h-7 text-[12.5px]"
                >
                  {providerCatalog.label(provider)}
                </ChipButton>
              ))}
            </ChipRow>
          )}
          {(chatgpt || copilotPersonal || copilotOrg) && (
            <ChipRow>
              <span className="self-center text-[12.5px] text-muted-foreground">
                or use a subscription:
              </span>
              {chatgpt && (
                <ChipButton onClick={() => setSubscription(chatgpt)}>
                  <ProviderLogo provider="openai" />
                  {chatgpt.name}
                </ChipButton>
              )}
              {copilotPersonal && copilotOrg ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <ChipButton>
                      <ProviderLogo provider="github-copilot" />
                      GitHub Copilot
                    </ChipButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => setSubscription(copilotPersonal)}
                    >
                      Personal subscription
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setCopilotOrgOpen(true)}>
                      {providerCatalog.enterprisePlanName}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : copilotPersonal || copilotOrg ? (
                <ChipButton
                  onClick={() =>
                    copilotPersonal
                      ? setSubscription(copilotPersonal)
                      : setCopilotOrgOpen(true)
                  }
                >
                  <ProviderLogo provider="github-copilot" />
                  GitHub Copilot
                </ChipButton>
              ) : null}
            </ChipRow>
          )}
        </EmptyBox>
      ) : (
        <ChipRow>
          {providers.slice(0, VISIBLE_PROVIDERS).map((provider) => {
            const count = modelCount(provider);
            const label = providerCatalog.label(provider);
            return (
              <ChipLink
                key={provider}
                href={modelsHref(provider)}
                title={`${label} · ${count} ${count === 1 ? "model" : "models"}`}
              >
                <ProviderLogo provider={provider} />
                {label}
                <span
                  className="rounded-full bg-foreground/[0.07] px-1.5 py-px text-[11px] font-medium"
                  role="img"
                  aria-label={`${count} ${count === 1 ? "model" : "models"}`}
                >
                  {count}
                </span>
                {needsAttention(provider) && (
                  <span
                    role="img"
                    aria-label="Needs reconnecting"
                    className="size-1.5 shrink-0 rounded-full bg-destructive"
                  />
                )}
              </ChipLink>
            );
          })}
          <MoreLink
            href="/llm/model-providers"
            count={providers.length - VISIBLE_PROVIDERS}
          />
        </ChipRow>
      )}

      {adding !== undefined && (
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdding(undefined);
          }}
          title="Add API Key"
          description="The proxy uses this key to call the provider."
          allowedProviders={adding ? [adding] : undefined}
          credentialMode="api-key"
          showConsoleLink
        />
      )}
      {subscription && (
        <CreateLlmProviderApiKeyDialog
          key={subscription.kind}
          open
          onOpenChange={(open) => {
            if (!open) setSubscription(null);
          }}
          title={
            SUBSCRIPTION_CREDENTIALS[subscription.kind].connect.signInTitle
          }
          description={
            SUBSCRIPTION_CREDENTIALS[subscription.kind].connect
              .signInDescription
          }
          defaultValues={subscription.defaultValues}
          allowedProviders={[subscription.provider]}
          credentialMode="subscription"
        />
      )}
      {copilotOrgOpen && (
        <CopilotOrganizationConnectDialog
          open
          onOpenChange={setCopilotOrgOpen}
          manage={null}
        />
      )}
    </DashboardCard>
  );
}
