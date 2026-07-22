"use client";

import {
  EXTERNAL_AGENT_ID_HEADER,
  isSupportedProvider,
  providerDisplayNames,
  type SupportedProvider,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { AlertTriangle, Check, Copy, Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ConnectionCreditWarning,
  CreditWarningNotice,
} from "@/components/connection/credit-warning-notice";
import { CopyableCode } from "@/components/copyable-code";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionVirtualKey,
} from "@/lib/connection-setup.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";
import type { ConnectClient, ProxyStep } from "./clients";
import { UnsupportedPanel } from "./mcp-client-instructions";
import { TerminalBlock } from "./terminal-block";
import { useUpdateUrlParams } from "./use-update-url-params";

/** Compact provider tile — colored square with a short glyph or letter. */
const PROVIDER_ICONS: Record<
  SupportedProvider,
  { bg: string; fg: string; glyph: string }
> = {
  openai: { bg: "#10a37f", fg: "#fff", glyph: "◎" },
  anthropic: { bg: "#D97757", fg: "#fff", glyph: "A" },
  gemini: {
    bg: "linear-gradient(135deg, #4285f4 0%, #9b72cb 50%, #d96570 100%)",
    fg: "#fff",
    glyph: "✦",
  },
  bedrock: { bg: "#232f3e", fg: "#ff9900", glyph: "aws" },
  azure: { bg: "#0078d4", fg: "#fff", glyph: "▲" },
  groq: { bg: "#f55036", fg: "#fff", glyph: "G" },
  cerebras: { bg: "#ff4d1c", fg: "#fff", glyph: "◆" },
  openrouter: { bg: "#1e1b4b", fg: "#fff", glyph: "↯" },
  ollama: { bg: "#fff1ea", fg: "#1e1b4b", glyph: "◎" },
  vllm: { bg: "#fafaff", fg: "#1e1b4b", glyph: "◇" },
  cohere: { bg: "#ff7759", fg: "#fff", glyph: "c" },
  mistral: { bg: "#ff7000", fg: "#fff", glyph: "M" },
  perplexity: { bg: "#20808d", fg: "#fff", glyph: "✳" },
  xai: { bg: "#000", fg: "#fff", glyph: "X" },
  deepseek: { bg: "#4d6bfe", fg: "#fff", glyph: "D" },
  minimax: { bg: "#0ea5a4", fg: "#fff", glyph: "M" },
  kimi: { bg: "#0d0d0d", fg: "#fff", glyph: "K" },
  zhipuai: { bg: "#dc2626", fg: "#fff", glyph: "Z" },
  "github-copilot": { bg: "#24292f", fg: "#fff", glyph: "gh" },
  "microsoft-365-copilot": { bg: "#0078d4", fg: "#fff", glyph: "ms" },
  archestra: { bg: "#000", fg: "#fff", glyph: "A" },
};

/** Original upstream base URLs — shown struck through next to the proxy URL. */
const PROVIDER_ORIGINAL_URLS: Record<SupportedProvider, string> = {
  openai: "https://api.openai.com/v1/",
  anthropic: "https://api.anthropic.com/v1/",
  gemini: "https://generativelanguage.googleapis.com/",
  bedrock: "https://bedrock-runtime.<region>.amazonaws.com/",
  azure: "https://<resource>.openai.azure.com/",
  groq: "https://api.groq.com/openai/v1/",
  cerebras: "https://api.cerebras.ai/v1/",
  openrouter: "https://openrouter.ai/api/v1/",
  ollama: "http://localhost:11434/v1/",
  vllm: "http://<host>:8000/v1/",
  cohere: "https://api.cohere.com/v2/",
  mistral: "https://api.mistral.ai/v1/",
  perplexity: "https://api.perplexity.ai/",
  xai: "https://api.x.ai/v1/",
  deepseek: "https://api.deepseek.com/",
  minimax: "https://api.minimax.io/v1/",
  kimi: "https://api.moonshot.ai/v1/",
  zhipuai: "https://open.bigmodel.cn/api/",
  "github-copilot": "https://api.githubcopilot.com/",
  "microsoft-365-copilot": "https://graph.microsoft.com/beta/",
  archestra: "https://<archestra-host>/v1/model-router/<llm-proxy-id>/",
};

interface ProxyClientInstructionsProps {
  client: ConnectClient;
  profileId: string;
  /** Display name of the LLM proxy (profile) — used as a provider id in client configs. */
  profileName: string;
  /** When null/undefined: show all providers. Otherwise: only these. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Connection base URL chosen at the page level (see ConnectionUrlStep). */
  baseUrl: string;
}

const ALL_PROVIDERS = Object.keys(providerDisplayNames) as SupportedProvider[];

/**
 * providerId URL value for the Model Router tile. Not a real provider —
 * isSupportedProvider() rejects it, so every other providerId consumer
 * (script/config clients, deep links) safely treats it as "none selected".
 */
const MODEL_ROUTER_TILE = "model-router";

/**
 * Slugify the LLM proxy name into a TOML-friendly identifier (e.g. used as
 * `[model_providers.<slug>]` in Codex's config).
 */
function toProxyProviderSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "archestra";
}

export function ProxyClientInstructions({
  client,
  profileId,
  profileName,
  shownProviders,
  baseUrl,
}: ProxyClientInstructionsProps) {
  const shownSet = useMemo(
    () => (shownProviders ? new Set(shownProviders) : null),
    [shownProviders],
  );
  const isShown = useCallback(
    (p: SupportedProvider) => !shownSet || shownSet.has(p),
    [shownSet],
  );

  const searchParams = useSearchParams();
  const urlProvider = searchParams.get("providerId");
  const updateUrlParams = useUpdateUrlParams();
  const updateProviderInUrl = useCallback(
    (value: string | null) => updateUrlParams({ providerId: value }),
    [updateUrlParams],
  );

  const rawSupportedProviders = useMemo(
    () =>
      client.proxy.kind === "custom"
        ? client.proxy.supportedProviders
        : client.proxy.kind === "generic"
          ? ALL_PROVIDERS
          : [],
    [client.proxy],
  );
  const supportedProviders = useMemo(
    () => rawSupportedProviders.filter(isShown),
    [rawSupportedProviders, isShown],
  );
  const visibleAllProviders = useMemo(
    () => ALL_PROVIDERS.filter(isShown),
    [isShown],
  );

  // Drive selection off the URL so client switches (which clear providerId in
  // the URL) immediately reset the picker without stale local state.
  const selectedProvider: SupportedProvider | null =
    urlProvider && isSupportedProvider(urlProvider) && isShown(urlProvider)
      ? urlProvider
      : null;

  // Generic clients get the Model Router as the first tile of the grid;
  // custom clients build per-provider instructions and don't offer it.
  const routerAvailable = client.proxy.kind === "generic";
  const routerSelected = routerAvailable && urlProvider === MODEL_ROUTER_TILE;

  // Auto-select the first tile when nothing is chosen yet, so the card opens
  // with instructions expanded instead of a blank grid: the Model Router for
  // generic clients, the first provider otherwise.
  useEffect(() => {
    if (selectedProvider || routerSelected) return;
    if (routerAvailable) {
      updateProviderInUrl(MODEL_ROUTER_TILE);
    } else if (supportedProviders.length > 0) {
      updateProviderInUrl(supportedProviders[0]);
    }
  }, [
    selectedProvider,
    routerSelected,
    routerAvailable,
    supportedProviders,
    updateProviderInUrl,
  ]);

  const handleProviderSelect = (p: SupportedProvider) => {
    updateProviderInUrl(p);
  };

  const providerLabel = selectedProvider
    ? providerDisplayNames[selectedProvider]
    : null;
  const url = selectedProvider
    ? `${baseUrl}/${selectedProvider}/${profileId}`
    : null;
  const isCompatible =
    !!selectedProvider && supportedProviders.includes(selectedProvider);

  const instruction = useMemo(() => {
    if (client.proxy.kind !== "custom") return null;
    if (!selectedProvider || !providerLabel || !url) return null;
    return client.proxy.build({
      provider: selectedProvider,
      providerLabel,
      url,
      tokenPlaceholder: `<your-${selectedProvider}-api-key>`,
      proxyName: toProxyProviderSlug(profileName),
    });
  }, [client.proxy, selectedProvider, providerLabel, url, profileName]);

  if (client.proxy.kind === "unsupported") {
    return <UnsupportedPanel reason={client.proxy.reason} />;
  }

  const gridProviders =
    client.proxy.kind === "generic" ? visibleAllProviders : supportedProviders;
  const rawProviderCount =
    client.proxy.kind === "generic"
      ? ALL_PROVIDERS.length
      : rawSupportedProviders.length;
  const hiddenByAdmin = gridProviders.length === 0 && rawProviderCount > 0;

  if (gridProviders.length === 0) {
    return <NoProvidersPanel client={client} hiddenByAdmin={hiddenByAdmin} />;
  }

  return (
    <div id="proxy-instructions" className="space-y-4">
      {routerAvailable ? (
        <GenericEndpointCard
          baseUrl={baseUrl}
          profileId={profileId}
          providers={visibleAllProviders}
          routerSelected={routerSelected}
          selectedProvider={selectedProvider}
          onSelectRouter={() => updateProviderInUrl(MODEL_ROUTER_TILE)}
          onSelectProvider={handleProviderSelect}
        />
      ) : (
        <ProviderPicker
          providers={gridProviders}
          supported={supportedProviders}
          selected={selectedProvider}
          onSelect={handleProviderSelect}
        />
      )}

      {routerSelected ? (
        <ModelRouterInstructions />
      ) : !selectedProvider ? null : client.proxy.kind === "generic" &&
        providerLabel ? (
        <GenericProxyInstructions
          selectedProvider={selectedProvider}
          providerLabel={providerLabel}
        />
      ) : isCompatible && instruction ? (
        instruction.kind === "snippet" ? (
          <div className="space-y-2">
            <TerminalBlock code={instruction.code} />
            {instruction.note && <ProxyNote note={instruction.note} />}
          </div>
        ) : instruction.kind === "steps" ? (
          <div className="space-y-3">
            {instruction.note && <ProxyNote note={instruction.note} />}
            <StepList steps={instruction.steps} llmProxyId={profileId} />
          </div>
        ) : (
          <div className="space-y-6">
            {instruction.sections.map((sec) => (
              <div key={sec.title} className="space-y-3">
                <div>
                  <div className="text-[14px] font-semibold text-foreground">
                    {sec.title}
                  </div>
                  {sec.description && (
                    <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                      {sec.description}
                    </div>
                  )}
                </div>
                <StepList steps={sec.steps} llmProxyId={profileId} />
              </div>
            ))}
            {instruction.note && <ProxyNote note={instruction.note} />}
          </div>
        )
      ) : (
        <UnsupportedPanel
          reason={`${client.label} doesn't support this provider.`}
        />
      )}
    </div>
  );
}

type GenericAuthMethod = "provider-key" | "virtual-key";

/**
 * The "Any client" step 4 body for a single provider: the user decides how to
 * authenticate — bring their own provider key (passthrough) or have us
 * auto-provision a personal virtual key (the same provisioning the one-command
 * setup performs, gated by llmVirtualKey:create). The Model Router lives in
 * its own first tile of the grid ({@link ModelRouterInstructions}).
 */
function GenericProxyInstructions({
  selectedProvider,
  providerLabel,
}: {
  selectedProvider: SupportedProvider;
  providerLabel: string;
}) {
  const [authMethod, setAuthMethod] =
    useState<GenericAuthMethod>("provider-key");
  const { data: canCreateVirtualKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateProviderKey } = useHasPermissions({
    llmProviderApiKey: ["create"],
  });
  const [showAddProviderKey, setShowAddProviderKey] = useState(false);
  const provisionKey = useCreateConnectionVirtualKey();
  const provisionAsync = provisionKey.mutateAsync;
  const [virtualKey, setVirtualKey] = useState<{
    value: string;
    name: string;
    creditWarning?: ConnectionCreditWarning | null;
  } | null>(null);

  // A virtual key can only wrap a provider key the user can resolve. Mirror the
  // one-command flow: only offer the option when the selected provider has a
  // configured key — otherwise provisioning would 400 ("no key configured").
  const { data: availableKeys } = useAvailableLlmProviderApiKeys();
  const providerHasKey = useMemo(
    () => (availableKeys ?? []).some((k) => k.provider === selectedProvider),
    [availableKeys, selectedProvider],
  );
  const offerVirtualKey = canCreateVirtualKey === true && providerHasKey;

  // A freshly provisioned key is scoped to the current provider; drop it when
  // the provider or auth mode changes so a stale key is never shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the reset triggers, not values read
  useEffect(() => {
    setVirtualKey(null);
  }, [selectedProvider, authMethod]);

  useEffect(() => {
    if (!offerVirtualKey && authMethod === "virtual-key") {
      setAuthMethod("provider-key");
    }
  }, [offerVirtualKey, authMethod]);

  // Auto-provision the moment the user picks the virtual-key tab — no extra
  // "generate" click. ensureConnectionVirtualKey reuses an existing key, so a
  // repeat call (e.g. React strict-mode double-invoke) is idempotent.
  const provisioningRef = useRef(false);
  useEffect(() => {
    if (authMethod !== "virtual-key" || !offerVirtualKey || virtualKey) return;
    if (provisioningRef.current) return;
    provisioningRef.current = true;
    let cancelled = false;
    provisionAsync({ provider: selectedProvider })
      .then((result) => {
        if (!cancelled && result) setVirtualKey(result);
      })
      .finally(() => {
        provisioningRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [
    authMethod,
    offerVirtualKey,
    selectedProvider,
    virtualKey,
    provisionAsync,
  ]);

  return (
    <div className="space-y-3">
      <div className="space-y-4 rounded-lg border bg-card p-4">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Authentication
          </div>
          <Tabs
            value={authMethod}
            onValueChange={(v) => setAuthMethod(v as GenericAuthMethod)}
          >
            <TabsList>
              <TabsTrigger value="provider-key">Your provider key</TabsTrigger>
              <TabsTrigger value="virtual-key" disabled={!offerVirtualKey}>
                Virtual key
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {authMethod === "provider-key" ? (
              canCreateVirtualKey && !providerHasKey ? (
                <>
                  Passthrough — you keep using your own {providerLabel} key. A
                  virtual key needs a configured {providerLabel} provider key
                  first
                  {canCreateProviderKey ? (
                    <>
                      {" "}
                      (
                      <button
                        type="button"
                        className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                        onClick={() => setShowAddProviderKey(true)}
                      >
                        add one
                      </button>
                      ).
                    </>
                  ) : (
                    " (ask an admin to add one)."
                  )}
                </>
              ) : (
                "Passthrough — you keep using your own provider API key; only the base URL changes."
              )
            ) : (
              "A personal virtual key mapped to your provider key is created automatically and shown below."
            )}
          </p>
          {authMethod === "virtual-key" &&
            (virtualKey ? (
              <div className="space-y-1.5">
                <CopyableCode
                  value={virtualKey.value}
                  variant="primary"
                  toastMessage="Virtual key copied"
                />
                <p className="text-[11px] text-muted-foreground">
                  Use this as your API key. Revoke it any time by deleting the
                  &quot;{virtualKey.name}&quot; key on the Virtual API Keys
                  page.
                </p>
                <CreditWarningNotice warning={virtualKey.creditWarning} />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Creating your virtual key…
              </div>
            ))}
        </div>
      </div>

      <CreateLlmProviderApiKeyDialog
        open={showAddProviderKey}
        onOpenChange={setShowAddProviderKey}
        title={`Add a ${providerLabel} provider key`}
        description={`Add a provider API key so a virtual key can be minted from it. This unlocks the virtual-key option for ${providerLabel}.`}
        defaultValues={{ provider: selectedProvider }}
        allowedProviders={[selectedProvider]}
        onSuccess={() => setShowAddProviderKey(false)}
      />
    </div>
  );
}

/**
 * The Model Router auth panel behind the first tab of the endpoint card
 * (generic clients). One OpenAI-compatible endpoint that reaches every
 * configured provider via provider-qualified model IDs (`openai:gpt-5.4`) —
 * /v1/openai is just the OpenAI passthrough proxy; only /v1/model-router fans
 * out across providers. A virtual key wraps exactly one stored provider key,
 * so router setups pick which provider the minted key maps to.
 */
function ModelRouterInstructions() {
  const [authMethod, setAuthMethod] =
    useState<GenericAuthMethod>("provider-key");
  const { data: canCreateVirtualKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });

  const { data: availableKeys } = useAvailableLlmProviderApiKeys();
  const providersWithKeys = useMemo(() => {
    const configured = new Set((availableKeys ?? []).map((k) => k.provider));
    return ALL_PROVIDERS.filter((p) => configured.has(p));
  }, [availableKeys]);
  const [pickedProvider, setPickedProvider] =
    useState<SupportedProvider | null>(null);
  const mappedProvider =
    pickedProvider && providersWithKeys.includes(pickedProvider)
      ? pickedProvider
      : (providersWithKeys[0] ?? null);
  const offerVirtualKey = canCreateVirtualKey === true && !!mappedProvider;

  const provisionKey = useCreateConnectionVirtualKey();
  const provisionAsync = provisionKey.mutateAsync;
  const [virtualKey, setVirtualKey] = useState<{
    value: string;
    name: string;
    creditWarning?: ConnectionCreditWarning | null;
  } | null>(null);

  // A provisioned key is scoped to the mapped provider; drop it when the
  // mapping or auth mode changes so a stale key is never shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the reset triggers, not values read
  useEffect(() => {
    setVirtualKey(null);
  }, [mappedProvider, authMethod]);

  useEffect(() => {
    if (!offerVirtualKey && authMethod === "virtual-key") {
      setAuthMethod("provider-key");
    }
  }, [offerVirtualKey, authMethod]);

  // Same auto-provision-on-tab-pick behavior as the per-provider flow;
  // ensureConnectionVirtualKey is idempotent per provider.
  const provisioningRef = useRef(false);
  useEffect(() => {
    if (authMethod !== "virtual-key" || !offerVirtualKey || virtualKey) return;
    if (!mappedProvider || provisioningRef.current) return;
    provisioningRef.current = true;
    let cancelled = false;
    provisionAsync({ provider: mappedProvider })
      .then((result) => {
        if (!cancelled && result) setVirtualKey(result);
      })
      .finally(() => {
        provisioningRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [authMethod, offerVirtualKey, mappedProvider, virtualKey, provisionAsync]);

  return (
    <div className="space-y-3">
      <div className="space-y-4 rounded-lg border bg-card p-4">
        <p className="text-xs text-muted-foreground">
          One OpenAI-style endpoint for every configured provider. Send
          provider-qualified model IDs like{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            openai:gpt-5.4
          </code>{" "}
          or{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
            anthropic:claude-sonnet-5
          </code>{" "}
          instead of switching base URLs per provider.
        </p>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Authentication
          </div>
          <Tabs
            value={authMethod}
            onValueChange={(v) => setAuthMethod(v as GenericAuthMethod)}
          >
            <TabsList>
              <TabsTrigger value="provider-key">Your provider key</TabsTrigger>
              <TabsTrigger value="virtual-key" disabled={!offerVirtualKey}>
                Virtual key
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {authMethod === "provider-key" ? (
            <p className="text-xs text-muted-foreground">
              Passthrough — you keep using your own provider API key. Works when
              the model's provider prefix matches the key (e.g.{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                openai:gpt-5.4
              </code>{" "}
              with an OpenAI key).
            </p>
          ) : (
            <div className="space-y-2">
              {providersWithKeys.length > 1 && mappedProvider && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>Mint the key from the</span>
                  <Select
                    value={mappedProvider}
                    onValueChange={(v) =>
                      setPickedProvider(v as SupportedProvider)
                    }
                  >
                    <SelectTrigger size="sm" className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providersWithKeys.map((p) => (
                        <SelectItem key={p} value={p}>
                          {providerDisplayNames[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span>provider key</span>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                A personal virtual key mapped to your
                {mappedProvider
                  ? ` ${providerDisplayNames[mappedProvider]}`
                  : ""}{" "}
                provider key is created automatically and shown below. Models
                from other providers need a key mapped to that provider.
              </p>
              {virtualKey ? (
                <div className="space-y-1.5">
                  <CopyableCode
                    value={virtualKey.value}
                    variant="primary"
                    toastMessage="Virtual key copied"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Use this as your API key. Revoke it any time by deleting the
                    &quot;{virtualKey.name}&quot; key on the Virtual API Keys
                    page.
                  </p>
                  <CreditWarningNotice warning={virtualKey.creditWarning} />
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Creating your virtual key…
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Tab button in the endpoint terminal card — same look as the setup-script card's provider toggler. */
function endpointTabClass(active: boolean) {
  return cn(
    "border-b-2 px-2.5 py-2.5 font-mono text-xs transition-colors",
    active
      ? "border-white font-semibold text-white"
      : "border-transparent text-[#9ca3af] hover:text-white",
  );
}

/**
 * The generic client's proxy endpoint card: the same terminal card + provider
 * toggler as "Run the setup script". Tabs switch between the Model Router and
 * provider routes (primary providers inline, the rest behind a searchable "…"
 * — a provider picked there joins the tab row so the selection stays visible);
 * the proxy URL for the active tab renders below. Also used by the admin
 * connect dialog on the proxies table (with a custom caption).
 */
export function GenericEndpointCard({
  baseUrl,
  profileId,
  providers,
  routerSelected,
  selectedProvider,
  onSelectRouter,
  onSelectProvider,
  caption,
}: {
  baseUrl: string;
  profileId: string;
  providers: SupportedProvider[];
  routerSelected: boolean;
  selectedProvider: SupportedProvider | null;
  onSelectRouter: () => void;
  onSelectProvider: (p: SupportedProvider) => void;
  /** Overrides the default "Replace the … base URL … with:" line. */
  caption?: React.ReactNode;
}) {
  const PRIMARY: SupportedProvider[] = [
    "openai",
    "anthropic",
    "gemini",
    "bedrock",
    "groq",
  ];
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const primary = providers.filter((p) => PRIMARY.includes(p));
  const rest = providers.filter((p) => !PRIMARY.includes(p));
  const selectedFromRest =
    selectedProvider && rest.includes(selectedProvider)
      ? selectedProvider
      : null;
  const tabProviders = selectedFromRest
    ? [...primary, selectedFromRest]
    : primary;
  const searchResults = rest.filter((p) =>
    providerDisplayNames[p].toLowerCase().includes(search.toLowerCase()),
  );

  const label = routerSelected
    ? "OpenAI-compatible"
    : selectedProvider
      ? providerDisplayNames[selectedProvider]
      : "";
  const originalUrl = routerSelected
    ? "https://api.openai.com/v1/"
    : selectedProvider
      ? PROVIDER_ORIGINAL_URLS[selectedProvider]
      : "";
  const url = routerSelected
    ? `${baseUrl}/model-router/${profileId}`
    : `${baseUrl}/${selectedProvider}/${profileId}`;

  // Bedrock exposes two endpoints; both live in the same card as labeled rows.
  const rows =
    !routerSelected && selectedProvider === "bedrock"
      ? [
          {
            comment: "Bedrock Converse API",
            code: `${baseUrl}/bedrock/${profileId}`,
          },
          {
            comment: "OpenAI Completions API compatible clients",
            code: `${baseUrl}/bedrock/openai/${profileId}`,
          },
        ]
      : undefined;

  return (
    <div className="space-y-2">
      {caption ?? (
        <div className="text-xs text-muted-foreground">
          Replace the{" "}
          <span className="font-medium text-foreground">{label}</span> base URL{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px] line-through opacity-60">
            {originalUrl}
          </code>{" "}
          with:
        </div>
      )}
      <TerminalBlock
        code={url}
        rows={rows}
        header={
          <div className="flex flex-wrap items-center gap-1 border-b border-[#1f2937] px-3">
            <button
              type="button"
              onClick={onSelectRouter}
              className={endpointTabClass(routerSelected)}
            >
              Model Router
            </button>
            {tabProviders.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onSelectProvider(p)}
                className={endpointTabClass(selectedProvider === p)}
              >
                {providerDisplayNames[p]}
              </button>
            ))}
            {rest.length > (selectedFromRest ? 1 : 0) && (
              <Popover
                open={searchOpen}
                onOpenChange={(open) => {
                  setSearchOpen(open);
                  if (!open) setSearch("");
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="More providers"
                    className={endpointTabClass(false)}
                  >
                    …
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64 p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput
                      value={search}
                      onValueChange={setSearch}
                      placeholder="Search providers..."
                    />
                    <CommandList>
                      <CommandEmpty>No providers found.</CommandEmpty>
                      <CommandGroup>
                        {searchResults.map((p) => (
                          <CommandItem
                            key={p}
                            value={p}
                            onSelect={() => {
                              onSelectProvider(p);
                              setSearchOpen(false);
                              setSearch("");
                            }}
                          >
                            {providerDisplayNames[p]}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            )}
          </div>
        }
      />
    </div>
  );
}

function NoProvidersPanel({
  client,
  hiddenByAdmin,
}: {
  client: ConnectClient;
  hiddenByAdmin: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      <div className="font-medium text-foreground">
        No providers available for {client.label}
      </div>
      <p className="mt-1">
        {hiddenByAdmin
          ? "Your admin hasn't enabled any of the providers this client supports."
          : "This client doesn't support any providers that are currently enabled."}
      </p>
    </div>
  );
}

function StepList({
  steps,
  llmProxyId,
}: {
  steps: ProxyStep[];
  /** LLM proxy the setup targets — needed to provision a passthrough key. */
  llmProxyId: string;
}) {
  return (
    <ol className="grid gap-5">
      {steps.map((s, i) => (
        <li
          key={s.title}
          className="grid grid-cols-[22px_1fr] items-start gap-3"
        >
          <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full border bg-muted/50 font-mono text-[11px] font-semibold text-muted-foreground">
            {i + 1}
          </div>
          <div className="min-w-0 space-y-3">
            <div>
              <div className="text-[13.5px] font-medium text-foreground">
                {s.title}
              </div>
              {s.body && (
                <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                  {s.body}
                </div>
              )}
            </div>
            {s.fields && s.fields.length > 0 && (
              <div className="grid gap-2">
                {s.fields.map((f) => (
                  <FieldRow
                    key={f.label}
                    label={f.label}
                    value={f.value}
                    copyable={f.copyable ?? true}
                  />
                ))}
              </div>
            )}
            {s.showPassthroughKey && (
              <PassthroughKeyField
                llmProxyId={llmProxyId}
                variant={s.passthroughKeyVariant ?? "header"}
                agentId={s.passthroughKeyAgentId}
              />
            )}
            {s.code && <TerminalBlock code={s.code} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Inline reveal for the manual attribution step: auto-provisions the caller's
 * personal passthrough virtual key (scoped to this proxy) and shows the header
 * name + copyable value to paste into the client's custom-headers field. Gated
 * on llmVirtualKey:create; otherwise points to the Virtual API Keys page.
 */
type PassthroughKeyState =
  | { status: "loading" }
  | { status: "done"; key: { value: string; name: string } }
  | { status: "error" };

function PassthroughKeyField({
  llmProxyId,
  variant,
  agentId,
}: {
  llmProxyId: string;
  variant: "header" | "env";
  /**
   * Optional client-attribution value sent as the X-Archestra-Agent-Id header
   * alongside the passthrough key (e.g. "anthropic_claude_code" / "anthropic_claude_desktop"). Not a
   * secret — shown in full.
   */
  agentId?: string;
}) {
  const { data: canCreate } = useHasPermissions({ llmVirtualKey: ["create"] });
  const { mutateAsync } = useCreateConnectionPassthroughKey();
  const [state, setState] = useState<PassthroughKeyState>({
    status: "loading",
  });

  // ensureConnectionPassthroughKey is idempotent server-side, so a single fire
  // is enough; always settle into done/error (never leave a dangling spinner —
  // an earlier cancelled-flag version could strand the UI on success).
  const runProvision = useCallback(() => {
    setState({ status: "loading" });
    mutateAsync({ llmProxyId })
      .then((result) =>
        setState(
          result ? { status: "done", key: result } : { status: "error" },
        ),
      )
      .catch(() => setState({ status: "error" }));
  }, [mutateAsync, llmProxyId]);

  // Auto-provision once the permission resolves. The ref fires exactly once and
  // survives React strict-mode's double-invoke.
  const firedRef = useRef(false);
  useEffect(() => {
    if (canCreate !== true || firedRef.current) return;
    firedRef.current = true;
    runProvision();
  }, [canCreate, runProvision]);

  if (canCreate === false) {
    return (
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        Create a passthrough virtual key on the{" "}
        <Link
          href="/credentials/virtual-keys"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Virtual API Keys
        </Link>{" "}
        page, then add a header named{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
          {VIRTUAL_KEY_HEADER}
        </code>{" "}
        with the key as its value.
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-[12.5px] leading-snug text-muted-foreground">
        Couldn&apos;t create a passthrough key.{" "}
        <button
          type="button"
          onClick={runProvision}
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Retry
        </button>{" "}
        or create one on the{" "}
        <Link
          href="/credentials/virtual-keys"
          className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
        >
          Virtual API Keys
        </Link>{" "}
        page.
      </p>
    );
  }

  if (state.status !== "done") {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Creating your passthrough key…
      </div>
    );
  }

  const { key } = state;
  // The agent-id line (non-secret) rides in the same ANTHROPIC_CUSTOM_HEADERS
  // value (env) or as its own header row (header), one "Name: Value" per line.
  const agentIdLine = agentId
    ? `${EXTERNAL_AGENT_ID_HEADER}: ${agentId}`
    : null;
  return (
    <div className="grid gap-2">
      {variant === "env" ? (
        // Paste as the ANTHROPIC_CUSTOM_HEADERS value. The key is a secret, so
        // it is masked on screen and copied in full; the agent-id is shown as-is.
        <StackedCopyField
          label="ANTHROPIC_CUSTOM_HEADERS"
          display={[agentIdLine, `${VIRTUAL_KEY_HEADER}: ${SECRET_MASK}`]
            .filter(Boolean)
            .join("\n")}
          copyValue={[agentIdLine, `${VIRTUAL_KEY_HEADER}: ${key.value}`]
            .filter(Boolean)
            .join("\n")}
        />
      ) : (
        <>
          {agentIdLine && (
            <StackedCopyField
              label="Header"
              display={EXTERNAL_AGENT_ID_HEADER}
              copyValue={EXTERNAL_AGENT_ID_HEADER}
            />
          )}
          {agentIdLine && (
            <StackedCopyField
              label="Value"
              display={agentId ?? ""}
              copyValue={agentId ?? ""}
            />
          )}
          <StackedCopyField
            label="Header"
            display={VIRTUAL_KEY_HEADER}
            copyValue={VIRTUAL_KEY_HEADER}
          />
          <StackedCopyField
            label="Value"
            display={SECRET_MASK}
            copyValue={key.value}
          />
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        Revoke any time by deleting the &quot;{key.name}&quot; key on the
        Virtual API Keys page.
      </p>
    </div>
  );
}

/** Mask shown in place of a secret value (the real value is only copied). */
const SECRET_MASK = "•".repeat(20);

/**
 * Stacked label + value with a copy button. `display` is what's shown on screen
 * (a mask for secrets); `copyValue` is what's written to the clipboard. The
 * stacked layout avoids the cramped fixed-width FieldRow label column.
 */
function StackedCopyField({
  label,
  display,
  copyValue,
}: {
  label: string;
  display: string;
  copyValue: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-[#9ca3af]">
            {label}
          </div>
          <code className="block truncate font-mono text-[13px] text-[#e5e7eb]">
            {display}
          </code>
        </div>
        <FieldCopyButton value={copyValue} />
      </div>
    </div>
  );
}

function FieldRow({
  label,
  value,
  copyable,
}: {
  label: string;
  value: string;
  copyable: boolean;
}) {
  if (!copyable) {
    return (
      <div className="grid grid-cols-[140px_1fr] items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3">
        <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <span className="min-w-0 truncate text-[13px] italic text-muted-foreground">
          {value}
        </span>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <div className="grid grid-cols-[140px_1fr_auto] items-center gap-3 px-4 py-3">
        <div className="font-mono text-[11px] font-medium uppercase tracking-wider text-[#9ca3af]">
          {label}
        </div>
        <code className="min-w-0 truncate font-mono text-[13px] text-[#e5e7eb]">
          {value}
        </code>
        <FieldCopyButton value={value} />
      </div>
    </div>
  );
}

function FieldCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    await copyToClipboard(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label="Copy to clipboard"
      className="flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
    >
      {copied ? (
        <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
      ) : (
        <Copy className="size-3.5" strokeWidth={2} />
      )}
    </button>
  );
}

function ProxyNote({ note }: { note: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12.5px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{note}</span>
    </div>
  );
}

interface ProviderPickerProps {
  providers: SupportedProvider[];
  supported: SupportedProvider[];
  selected: SupportedProvider | null;
  onSelect: (p: SupportedProvider) => void;
  /**
   * Render the OpenAI-compatible Model Router as the first segment (generic
   * clients only — custom clients build per-provider instructions).
   */
  modelRouter?: { selected: boolean; onSelect: () => void };
}

function ProviderPicker({
  providers,
  supported,
  selected,
  onSelect,
  modelRouter,
}: ProviderPickerProps) {
  const PRIMARY: SupportedProvider[] = [
    "openai",
    "anthropic",
    "gemini",
    "bedrock",
    "groq",
  ];
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const primary = providers.filter((p) => PRIMARY.includes(p));
  const rest = providers.filter((p) => !PRIMARY.includes(p));
  // A provider picked from the "..." search joins the group so the selection
  // stays visible.
  const selectedFromRest =
    selected && rest.includes(selected) ? selected : null;
  const searchResults = providers.filter((p) =>
    providerDisplayNames[p].toLowerCase().includes(search.toLowerCase()),
  );

  const pickFromSearch = (p: SupportedProvider) => {
    onSelect(p);
    setSearchOpen(false);
    setSearch("");
  };

  return (
    <div>
      <h4 className="pb-3 text-sm font-semibold text-foreground">
        Select a provider
      </h4>
      <ButtonGroup className="flex-wrap">
        {modelRouter && (
          <Button
            type="button"
            size="sm"
            variant={modelRouter.selected ? "secondary" : "outline"}
            onClick={modelRouter.onSelect}
            className={cn("gap-2", modelRouter.selected && "font-semibold")}
          >
            <span
              className="flex size-4 shrink-0 items-center justify-center rounded-sm font-mono text-[10px] font-bold"
              style={{
                background: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%)",
                color: "#fff",
              }}
            >
              ⇄
            </span>
            OpenAI compatible Model Router
          </Button>
        )}
        {primary.map((p) => (
          <ProviderPickerButton
            key={p}
            provider={p}
            isSupported={supported.includes(p)}
            isSelected={selected === p}
            onSelect={onSelect}
          />
        ))}
        {selectedFromRest && (
          <ProviderPickerButton
            provider={selectedFromRest}
            isSupported={supported.includes(selectedFromRest)}
            isSelected
            onSelect={onSelect}
          />
        )}
        {rest.length > 0 && (
          <Popover
            open={searchOpen}
            onOpenChange={(open) => {
              setSearchOpen(open);
              if (!open) setSearch("");
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="More providers"
                aria-expanded={searchOpen}
              >
                …
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search providers..."
                />
                <CommandList>
                  <CommandEmpty>No providers found.</CommandEmpty>
                  <CommandGroup>
                    {searchResults.map((p) => (
                      <CommandItem
                        key={p}
                        value={p}
                        onSelect={() => pickFromSearch(p)}
                        className="justify-between"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <ProviderGlyph provider={p} />
                          <span className="truncate">
                            {providerDisplayNames[p]}
                          </span>
                          {!supported.includes(p) && (
                            <span className="text-[11px] text-muted-foreground">
                              Not compatible
                            </span>
                          )}
                        </span>
                        <Check
                          className={cn(
                            "h-4 w-4",
                            selected === p ? "opacity-100" : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        )}
      </ButtonGroup>
    </div>
  );
}

function ProviderPickerButton({
  provider,
  isSupported,
  isSelected,
  onSelect,
}: {
  provider: SupportedProvider;
  isSupported: boolean;
  isSelected: boolean;
  onSelect: (p: SupportedProvider) => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={isSelected ? "secondary" : "outline"}
      onClick={() => onSelect(provider)}
      className={cn(
        "gap-2",
        isSelected && "font-semibold",
        !isSupported && "opacity-50",
      )}
    >
      <ProviderGlyph provider={provider} />
      {providerDisplayNames[provider]}
    </Button>
  );
}

function ProviderGlyph({ provider }: { provider: SupportedProvider }) {
  const icon = PROVIDER_ICONS[provider];
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-sm font-mono text-[9px] font-bold"
      style={{ background: icon.bg, color: icon.fg }}
    >
      {icon.glyph === "aws" ? (
        <span className="text-[5px] font-extrabold tracking-tight">aws</span>
      ) : (
        icon.glyph
      )}
    </span>
  );
}
