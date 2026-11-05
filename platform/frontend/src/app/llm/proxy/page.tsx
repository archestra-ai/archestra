"use client";

import { Waypoints } from "lucide-react";
import { useMemo, useState } from "react";
import {
  type AuthMethodOption,
  AuthMethodPicker,
  ConnectStep,
} from "@/components/connect-rail";
import {
  getProxyEndpointProviders,
  type ProxyEndpointProvider,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/components/connection/connection-flow.utils";
import { TerminalBlock } from "@/components/connection/terminal-block";
import {
  type LlmAuthMethod,
  LlmConnectSteps,
} from "@/components/llm-connect-steps";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { LlmProviderOptionLabel } from "@/components/llm-provider-select-items";
import { terminalRaisedClass } from "@/components/terminal-surface";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import config from "@/lib/config/config";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useOrganization } from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The LLM Proxy connection page, read top to bottom: pick the endpoint, pick
 * how requests authenticate, then follow the steps for that pair. Each step
 * shows what already exists — provider keys, virtual keys, OAuth clients — so
 * the request at the end is the one this deployment can actually serve.
 */
export default function LlmProxyPage() {
  const { baseUrl, organization } = useConnectionBaseUrl();
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const [selected, setSelected] = useState<
    "model-router" | ProxyEndpointProvider
  >("model-router");
  const [auth, setAuth] = useState<LlmAuthMethod>("standard");
  const providers = getProxyEndpointProviders(organization);
  // Passthrough has no Unified Model API route; picking the router falls back to
  // a standard key, and the choice returns when a provider is picked again.
  const effectiveAuth =
    selected === "model-router" && auth === "passthrough" ? "standard" : auth;
  const targetLabel =
    selected === "model-router"
      ? "Unified Model API"
      : providerCatalog.label(selected);

  return (
    // No inner cap: the page column is PageLayout's band, which is centred.
    // A narrower wrapper inside it is not centred in turn, so the steps sat
    // against the band's left edge with the leftover stranded on the right.
    <ol>
      <ConnectStep number={1} title="Endpoint">
        <ProxyEndpointCard
          baseUrl={baseUrl}
          providers={[...providers]}
          selected={selected}
          onSelect={setSelected}
        />
        <p className="text-sm text-muted-foreground">
          {endpointHint(selected, targetLabel)}
        </p>
      </ConnectStep>
      <ConnectStep number={2} title="Authentication">
        <AuthMethodPicker
          methods={AUTH_METHODS}
          value={effectiveAuth}
          onChange={setAuth}
          unavailable={
            selected === "model-router"
              ? { passthrough: PASSTHROUGH_ROUTER_REASON }
              : undefined
          }
        />
      </ConnectStep>
      <LlmConnectSteps
        // Selections belong to one endpoint and auth method; start over
        // when either changes.
        key={`${selected}:${effectiveAuth}`}
        firstNumber={3}
        baseUrl={baseUrl}
        selected={selected}
        auth={effectiveAuth}
        targetLabel={targetLabel}
        showKeyPools
      />
    </ol>
  );
}

// =========================================================================
// 1 · Endpoint
// =========================================================================

const PRIMARY_PROVIDERS: ProxyEndpointProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "bedrock",
  "groq",
];

/** Tab button in the endpoint terminal card. */
function endpointTabClass(active: boolean) {
  return cn(
    "flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors",
    active
      ? cn("border font-semibold", terminalRaisedClass)
      : "border border-transparent text-terminal-muted hover:bg-terminal-elevated hover:text-terminal-emphasis",
  );
}

/**
 * A terminal block with a Unified Model API tab and per-provider tabs (primary
 * providers inline, the rest behind a searchable "More providers"). URLs are
 * id-less — the proxy is a singleton, so the path is just `/v1/<provider>` or
 * `/v1/unified-model`.
 */
function ProxyEndpointCard({
  baseUrl,
  providers,
  selected,
  onSelect,
}: {
  baseUrl: string;
  providers: ProxyEndpointProvider[];
  selected: "model-router" | ProxyEndpointProvider;
  onSelect: (target: "model-router" | ProxyEndpointProvider) => void;
}) {
  const providerCatalog = useModelProviderCatalog({ fresh: true });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  // Providers with a key are the ones a client can reach, so they lead; the
  // usual defaults fill the row up to its minimum width.
  const configured = providers.filter((p) =>
    providerApiKeys.some((key) => key.provider === p),
  );
  const primary = [
    ...configured,
    ...PRIMARY_PROVIDERS.filter(
      (p) => providers.includes(p) && !configured.includes(p),
    ),
  ].slice(0, Math.max(PRIMARY_PROVIDERS.length, configured.length));
  const rest = providers.filter((p) => !primary.includes(p));
  const selectedFromRest =
    selected !== "model-router" && rest.includes(selected) ? selected : null;
  const tabProviders = selectedFromRest
    ? [...primary, selectedFromRest]
    : primary;
  const moreCount = rest.length - (selectedFromRest ? 1 : 0);

  const url = endpointUrl(baseUrl, selected);

  // Jev's URL is the endpoint itself; every other one is a base URL clients
  // append paths to. Bedrock exposes two, as labeled rows in the same card.
  const badge = selected === "jev" ? "POST" : "BASE URL";
  const rows =
    selected === "bedrock"
      ? [
          {
            comment: "Bedrock Converse API",
            badge,
            code: `${baseUrl}/bedrock`,
          },
          {
            comment: "OpenAI Completions API compatible clients",
            badge,
            code: `${baseUrl}/bedrock/openai`,
          },
        ]
      : [{ badge, code: url }];

  return (
    <TerminalBlock
      rows={rows}
      header={
        <div className="flex flex-wrap items-center gap-1 border-b border-terminal-edge p-1.5">
          <UnstyledButton
            type="button"
            onClick={() => onSelect("model-router")}
            className={endpointTabClass(selected === "model-router")}
          >
            <Waypoints className="size-3.5" />
            Unified Model API
          </UnstyledButton>
          {tabProviders.map((provider) => (
            <UnstyledButton
              key={provider}
              type="button"
              onClick={() => onSelect(provider)}
              className={endpointTabClass(selected === provider)}
            >
              <img
                src={PROVIDER_CONFIG[provider].icon}
                alt=""
                className="size-3.5 rounded-sm dark:invert"
              />
              {providerCatalog.label(provider)}
            </UnstyledButton>
          ))}
          {moreCount > 0 && (
            <SearchableSelect
              value=""
              onValueChange={(value) =>
                onSelect(value as ProxyEndpointProvider)
              }
              placeholder={`More providers (${moreCount})`}
              ariaLabel="More providers"
              searchPlaceholder="Search providers..."
              emptyMessage="No providers found."
              items={rest.map((provider) => {
                const label = providerCatalog.label(provider);
                return {
                  value: provider,
                  label,
                  content: (
                    <LlmProviderOptionLabel
                      icon={PROVIDER_CONFIG[provider].icon}
                      name={label}
                    />
                  ),
                };
              })}
              className="ml-1 h-auto w-auto min-w-0 justify-start gap-2 rounded-full border border-dashed border-terminal-edge bg-transparent px-3 py-1.5 font-normal text-terminal-muted text-xs shadow-none hover:bg-transparent hover:text-terminal-emphasis"
              contentClassName="w-64"
            />
          )}
        </div>
      }
    />
  );
}

// =========================================================================
// 2 · Authentication
// =========================================================================

const AUTH_METHODS: AuthMethodOption<LlmAuthMethod>[] = [
  {
    value: "standard",
    title: "Standard virtual key",
    description:
      "One key for your app. The proxy maps it to your provider keys.",
    manage: {
      label: "Manage virtual keys",
      href: "/llm/proxy/virtual-keys?keyType=standard",
    },
  },
  {
    value: "passthrough",
    title: "Passthrough",
    description:
      "Send your own provider key. A passthrough key in a header links requests to a user.",
    manage: {
      label: "Manage passthrough keys",
      href: "/llm/proxy/virtual-keys?keyType=passthrough",
    },
  },
  {
    value: "oauth",
    title: "OAuth client",
    description: "Apps call the proxy as themselves or for signed-in users.",
    manage: {
      label: "Manage OAuth clients",
      href: "/settings/oauth-clients?type=llm",
    },
  },
  {
    value: "idp",
    title: "Identity provider",
    description:
      "Use a JWT from your identity provider. Requests run with that user's access.",
    manage: {
      label: "Manage identity providers",
      href: "/settings/identity-providers",
    },
  },
];

const PASSTHROUGH_ROUTER_REASON =
  "The Unified Model API calls providers with your organization's provider keys, so it can't take your own. Pick a provider endpoint to use passthrough.";

// =========================================================================
// Internal helpers
// =========================================================================

/** Same base-URL resolution as the /connection page. */
function useConnectionBaseUrl() {
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  const baseUrl = useMemo(() => {
    const candidates = resolveCandidateBaseUrls({
      externalProxyUrls: config.api.externalProxyUrls,
      internalProxyUrl: config.api.internalProxyUrl,
      metadata: connectionBaseUrls,
    });
    const adminDefault = resolveAdminDefaultBaseUrl(connectionBaseUrls);
    return adminDefault && candidates.includes(adminDefault)
      ? adminDefault
      : candidates[0];
  }, [connectionBaseUrls]);
  return { baseUrl, organization };
}

/** Jev serves one decisions endpoint rather than a base URL clients extend. */
function endpointUrl(
  baseUrl: string,
  selected: "model-router" | ProxyEndpointProvider,
) {
  if (selected === "model-router") return `${baseUrl}/unified-model`;
  if (selected === "jev") return `${baseUrl}/jev/decisions`;
  return `${baseUrl}/${selected}`;
}

function endpointHint(
  selected: "model-router" | ProxyEndpointProvider,
  label: string,
) {
  if (selected === "model-router") {
    return "OpenAI-compatible. Prefix the model with its provider, like openai:gpt-5.4, or ask for a model pool by its name.";
  }
  if (selected === "jev") return "Decisions only: one endpoint, no chat.";
  return `Keep your ${label} SDK and change only the base URL.`;
}
