"use client";

import { Waypoints } from "lucide-react";
import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getProxyEndpointProviders,
  type ProxyEndpointProvider,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { TerminalBlock } from "@/app/connection/terminal-block";
import {
  type AuthMethodOption,
  AuthMethodPicker,
  ConnectStep,
} from "@/components/connect-rail";
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
        offerAutoModel
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

/**
 * How many provider tabs fit on one line beside the Unified Model API tab,
 * leaving room for "More providers" whenever any provider is left out. Widths
 * come from the measure row: Unified tab, one tab per candidate, More trigger
 * (measured at its widest, since it grows to show a chosen provider).
 */
function useTabsThatFit({
  rowRef,
  measureRef,
  candidates: candidateList,
  hasRest,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  measureRef: RefObject<HTMLDivElement | null>;
  candidates: ProxyEndpointProvider[];
  hasRest: boolean;
}): number {
  const [count, setCount] = useState(candidateList.length);
  // A stable copy: callers rebuild the array every render.
  const key = candidateList.join(",");
  const candidates = useMemo(
    () => (key ? (key.split(",") as ProxyEndpointProvider[]) : []),
    [key],
  );

  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;

    const compute = () => {
      // No layout yet (or none at all, as in jsdom): keep every tab.
      if (row.clientWidth === 0) {
        setCount(candidates.length);
        return;
      }
      const widths = Array.from(
        measure.children,
        (el) => el.getBoundingClientRect().width,
      );
      const unified = widths[0] ?? 0;
      const more = widths[widths.length - 1] ?? 0;
      const tabWidth = new Map(
        candidates.map((provider, i) => [provider, widths[i + 1] ?? 0]),
      );
      const style = getComputedStyle(row);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const moreMargin =
        Number.parseFloat(
          getComputedStyle(measure.children[widths.length - 1]).marginLeft,
        ) || 0;
      const available =
        row.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);

      const fits = (n: number, withMore: boolean) => {
        const used =
          unified +
          candidates
            .slice(0, n)
            .reduce((sum, p) => sum + (tabWidth.get(p) ?? 0) + gap, 0) +
          (withMore ? gap + moreMargin + more : 0);
        // Sub-pixel slack so rounding never pushes the last item to a new line.
        return used <= available - 1;
      };

      let n = candidates.length;
      if (hasRest || !fits(n, false)) {
        while (n > 0 && !fits(n, true)) n--;
      }
      setCount(n);
    };

    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [candidates, hasRest, rowRef, measureRef]);

  return Math.min(count, candidates.length);
}

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

  // The tabs stay on one line: those that don't fit go behind "More providers".
  // Picking from it never changes the tabs; the select shows the choice instead.
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const fitCount = useTabsThatFit({
    rowRef,
    measureRef,
    candidates: primary,
    hasRest: rest.length > 0,
  });
  const tabProviders = primary.slice(0, fitCount);
  const moreProviders = providers.filter((p) => !tabProviders.includes(p));
  const moreSelected =
    selected !== "model-router" && moreProviders.includes(selected)
      ? selected
      : "";

  // The measure row draws its labels as CSS content, so they take up the same
  // width without adding a second copy of each label to the page's text.
  const tabLabel = (text: string, measure = false) =>
    measure ? (
      <span data-label={text} className="before:content-[attr(data-label)]" />
    ) : (
      text
    );
  const providerTab = (provider: ProxyEndpointProvider, measure = false) => (
    <>
      <img
        src={PROVIDER_CONFIG[provider].icon}
        alt=""
        className="size-3.5 rounded-sm dark:invert"
      />
      {tabLabel(providerCatalog.label(provider), measure)}
    </>
  );
  // Bounded width: a long provider name truncates instead of crowding the tabs.
  const moreClassName =
    "ml-1 h-auto w-auto min-w-36 max-w-48 shrink-0 justify-start gap-2 rounded-full border border-dashed border-terminal-edge bg-transparent px-3 py-1.5 font-normal text-terminal-muted text-xs shadow-none hover:bg-transparent hover:text-terminal-emphasis";

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
        <div
          ref={rowRef}
          className="relative flex flex-wrap items-center gap-1 border-b border-terminal-edge p-1.5"
        >
          {/* Off-screen copy of every candidate tab, measured to decide which fit. */}
          <div
            ref={measureRef}
            aria-hidden
            inert
            className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-max items-center overflow-hidden"
          >
            <span className={endpointTabClass(true)}>
              <Waypoints className="size-3.5" />
              {tabLabel("Unified Model API", true)}
            </span>
            {primary.map((provider) => (
              <span key={provider} className={endpointTabClass(true)}>
                {providerTab(provider, true)}
              </span>
            ))}
            <SearchableSelect
              value=""
              onValueChange={() => {}}
              placeholder={`More providers (${providers.length})`}
              items={[]}
              className={cn(moreClassName, "w-48")}
            />
          </div>
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
              {providerTab(provider)}
            </UnstyledButton>
          ))}
          {moreProviders.length > 0 && (
            <SearchableSelect
              value={moreSelected}
              onValueChange={(value) =>
                onSelect(value as ProxyEndpointProvider)
              }
              placeholder={`More providers (${moreProviders.length})`}
              ariaLabel="More providers"
              searchPlaceholder="Search providers..."
              emptyMessage="No providers found."
              items={moreProviders.map((provider) => {
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
                  selectedContent: (
                    <span className="flex min-w-0 items-center gap-2">
                      <img
                        src={PROVIDER_CONFIG[provider].icon}
                        alt=""
                        className="size-3.5 shrink-0 rounded-sm dark:invert"
                      />
                      <span className="truncate">{label}</span>
                    </span>
                  ),
                };
              })}
              // Pinned right, so leftover room sits between the tabs and More.
              className={cn(
                moreClassName,
                "ml-auto",
                moreSelected &&
                  cn("border-solid font-semibold", terminalRaisedClass),
              )}
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
