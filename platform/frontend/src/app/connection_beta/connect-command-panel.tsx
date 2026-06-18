"use client";

import {
  providerDisplayNames,
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import { Check, CircleDashed, Copy, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type CreateConnectionSetupBody,
  type CreateConnectionSetupResult,
  useCreateConnectionSetup,
} from "@/lib/connection-setup.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";
import type { ConnectClient } from "./clients";
import type { ConnectionBaseUrl } from "./connection-flow.utils";
import { SearchableSelect } from "./searchable-select";
import {
  fetchAllSkillIds,
  useTotalSkillCount,
} from "./skills-marketplace-step";
import { WizardStep } from "./wizard-step";

type ScriptClientId = CreateConnectionSetupBody["clientId"];
type ConnectProxyAuth = NonNullable<CreateConnectionSetupBody["proxyAuth"]>;
type EditableRow = "endpoint" | "gateway" | "proxy" | "skills";

const SCRIPT_CLIENT_IDS: readonly string[] = [
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor",
] satisfies ScriptClientId[];

/** Clients whose whole setup is delivered as a single `curl | bash` command. */
export function isScriptClient(
  clientId: string | null,
): clientId is ScriptClientId {
  return clientId !== null && SCRIPT_CLIENT_IDS.includes(clientId);
}

/**
 * Whether skills can ride along in the setup command: feature on, caller is a
 * skill admin, and there is at least one skill to share.
 */
function useConnectSkills(): { eligible: boolean; totalSkills: number } {
  const skillsEnabled = useFeature("agentSkillsEnabled") === true;
  const { data: canAdminSkills } = useHasPermissions({ skill: ["admin"] });
  const { data: totalSkills } = useTotalSkillCount();
  return {
    eligible:
      skillsEnabled && canAdminSkills === true && (totalSkills ?? 0) > 0,
    totalSkills: totalSkills ?? 0,
  };
}

interface AgentOption {
  id: string;
  name: string;
}

interface ConnectCommandPanelProps {
  client: ConnectClient;
  /** null when the user can't read MCP gateways. */
  mcpGateways: AgentOption[] | null;
  mcpGatewayId: string | null;
  onMcpGatewaySelect: (id: string) => void;
  /** null when the user can't read LLM proxies. */
  llmProxies: AgentOption[] | null;
  llmProxyId: string | null;
  onLlmProxySelect: (id: string) => void;
  /** When null/undefined: all providers allowed. Otherwise: only these. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Provider pinned in the URL (bookmarkable); falls back to the first supported. */
  urlProvider: SupportedProvider | null;
  onProviderSelect: (provider: SupportedProvider) => void;
  baseUrl: string;
  candidateBaseUrls: readonly string[];
  baseUrlMetadata: readonly ConnectionBaseUrl[] | null | undefined;
  onBaseUrlChange: (url: string) => void;
}

/**
 * The whole "step 2" of the wizard: a terminal block whose one-time setup
 * command regenerates itself whenever a selection changes — no explicit
 * generate click. Defaults cover everything (default gateway, default proxy,
 * first supported provider, skills included); the rare overrides live behind
 * the Options disclosure.
 */
export function ConnectCommandPanel({
  client,
  mcpGateways,
  mcpGatewayId,
  onMcpGatewaySelect,
  llmProxies,
  llmProxyId,
  onLlmProxySelect,
  shownProviders,
  urlProvider,
  onProviderSelect,
  baseUrl,
  candidateBaseUrls,
  baseUrlMetadata,
  onBaseUrlChange,
}: ConnectCommandPanelProps) {
  const { eligible: skillsEligible, totalSkills } = useConnectSkills();
  const [skillsOptOut, setSkillsOptOut] = useState(false);
  const includeSkills = skillsEligible && !skillsOptOut;

  const [proxyAuth, setProxyAuth] = useState<ConnectProxyAuth>("provider-key");
  // Which summary line is currently expanded for inline editing (one at a time).
  const [editing, setEditing] = useState<EditableRow | null>(null);
  const toggleEdit = (row: EditableRow) =>
    setEditing((cur) => (cur === row ? null : row));

  // Providers that have an API key the current user can resolve. Virtual-key
  // setups can only be provisioned for these — passthrough doesn't need them.
  const { data: availableKeys } = useAvailableLlmProviderApiKeys();
  const configuredProviders = useMemo(
    () => new Set((availableKeys ?? []).map((k) => k.provider)),
    [availableKeys],
  );

  // Providers this client can be wired to at all, narrowed by the admin
  // allow-list (independent of auth mode — used to explain the empty state).
  const supportedProviders = useMemo(() => {
    const supported =
      client.proxy.kind === "custom" ? client.proxy.supportedProviders : [];
    const shown = shownProviders ? new Set(shownProviders) : null;
    return shown ? supported.filter((p) => shown.has(p)) : supported;
  }, [client.proxy, shownProviders]);

  // In virtual-key mode we further restrict to providers the user actually has
  // a key for — a virtual key can only be minted against a configured key — so
  // the tabs never offer a provider the command would fail on. Passthrough
  // needs no key (the user brings their own at runtime).
  const providers = useMemo(() => {
    if (proxyAuth !== "virtual-key") return supportedProviders;
    // Per-user providers (GitHub Copilot) stay selectable even without a key:
    // the user connects their own account inline, after which a personal
    // virtual key is minted. Other providers need a pre-existing key.
    return supportedProviders.filter(
      (p) => configuredProviders.has(p) || providerRequiresPerUserCredential(p),
    );
  }, [supportedProviders, proxyAuth, configuredProviders]);
  const provider =
    urlProvider && providers.includes(urlProvider)
      ? urlProvider
      : (providers[0] ?? null);

  // GitHub Copilot is per-user: it can only run through a personal virtual key,
  // never the passthrough device flow, and the user must connect their own
  // account before a command can be generated.
  const providerIsPerUser =
    !!provider && providerRequiresPerUserCredential(provider);
  const needsPerUserConnect =
    providerIsPerUser && !configuredProviders.has(provider);

  // Force virtual-key auth for per-user providers (no passthrough tab).
  useEffect(() => {
    if (providerIsPerUser && proxyAuth !== "virtual-key") {
      setProxyAuth("virtual-key");
    }
  }, [providerIsPerUser, proxyAuth]);

  const gateway = mcpGateways?.find((g) => g.id === mcpGatewayId) ?? null;
  // The selected proxy may exist without a usable provider (e.g. virtual-key
  // mode with no configured providers); keep it for the row/editor, but it
  // only joins the command when a provider is also resolved.
  const proxy = (llmProxies ?? []).find((p) => p.id === llmProxyId) ?? null;
  const proxyActive = !!(proxy && provider);
  const hasAnything = Boolean(gateway || proxyActive || includeSkills);

  const { mutateAsync: createSetup, isPending } = useCreateConnectionSetup();
  // Creating the personal key invalidates the available-keys query, so once the
  // user connects, `configuredProviders` updates and the command auto-generates.
  const createPerUserKey = useCreateLlmProviderApiKey();
  const [result, setResult] = useState<CreateConnectionSetupResult | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  // One key per distinct setup payload. The effect below regenerates when it
  // changes; the ref guards against an older in-flight response overwriting a
  // newer one.
  const inputsKey = JSON.stringify({
    clientId: client.id,
    baseUrl,
    gatewayId: gateway?.id ?? null,
    proxyId: proxyActive ? proxy.id : null,
    provider: proxyActive ? provider : null,
    proxyAuth: proxyActive ? proxyAuth : null,
    includeSkills,
  });
  const latestKeyRef = useRef(inputsKey);
  latestKeyRef.current = inputsKey;

  const runGeneration = useCallback(
    async (key: string) => {
      const inputs = JSON.parse(key) as {
        clientId: ScriptClientId;
        baseUrl: string;
        gatewayId: string | null;
        proxyId: string | null;
        provider: SupportedProvider | null;
        proxyAuth: ConnectProxyAuth | null;
        includeSkills: boolean;
      };

      let skills: CreateConnectionSetupBody["skills"];
      if (inputs.includeSkills) {
        const skillIds = await fetchAllSkillIds();
        // The marketplace link the client clones from must outlive the one-time
        // setup token, so it never expires — admins revoke it from the Skills
        // page when needed.
        if (skillIds.length > 0) skills = { skillIds, ttlDays: null };
      }
      if (!inputs.gatewayId && !inputs.proxyId && !skills) return;

      const created = await createSetup({
        clientId: inputs.clientId,
        baseUrl: inputs.baseUrl,
        mcpGatewayId: inputs.gatewayId ?? undefined,
        llmProxyId: inputs.proxyId ?? undefined,
        provider: inputs.provider ?? undefined,
        proxyAuth: inputs.proxyAuth ?? undefined,
        skills,
      });
      if (latestKeyRef.current !== key) return; // stale response
      setResult(created);
      setFailed(!created);
    },
    [createSetup],
  );

  useEffect(() => {
    setResult(null);
    setFailed(false);
    // Don't try to generate a command until the user has connected their
    // per-user account — the backend would reject it (no key to mint from).
    if (!hasAnything || needsPerUserConnect) return;
    const timer = setTimeout(() => {
      void runGeneration(inputsKey);
    }, 350);
    return () => clearTimeout(timer);
  }, [inputsKey, hasAnything, needsPerUserConnect, runGeneration]);

  // Each summary line owns its inline editor. A line is editable only when it
  // has a real choice (e.g. more than one gateway); otherwise no "Change".
  const canPickGateway =
    !!gateway && mcpGateways !== null && mcpGateways.length > 1;
  const gatewayEditor = canPickGateway ? (
    <div className="grid gap-3">
      {mcpGateways && mcpGateways.length > 1 && gateway && (
        <EditorField label="Gateway">
          <SearchableSelect
            options={mcpGateways.map((g) => ({ value: g.id, label: g.name }))}
            value={gateway.id}
            onValueChange={onMcpGatewaySelect}
            placeholder="Select gateway"
          />
        </EditorField>
      )}
    </div>
  ) : null;

  // The endpoint (base URL) is shared by both the MCP gateway and the LLM
  // proxy, so it gets its own line/setting rather than living under either.
  const showEndpoint = candidateBaseUrls.length > 1;
  const endpointEditor = (
    <EditorField label="Endpoint">
      <BaseUrlSelect
        candidateUrls={candidateBaseUrls}
        metadata={baseUrlMetadata}
        value={baseUrl}
        onChange={onBaseUrlChange}
      />
    </EditorField>
  );

  const proxyEditor = proxy ? (
    <div className="grid gap-3">
      {llmProxies && llmProxies.length > 1 && (
        <EditorField label="Proxy">
          <SearchableSelect
            options={llmProxies.map((p) => ({ value: p.id, label: p.name }))}
            value={proxy.id}
            onValueChange={onLlmProxySelect}
            placeholder="Select proxy"
          />
        </EditorField>
      )}
      <EditorField label="Auth">
        <div className="grid gap-1.5">
          {/* Per-user providers (GitHub Copilot) can't use passthrough — their
              raw token must never be embedded in a shared command — so only the
              virtual-key path is offered. */}
          {providerIsPerUser ? (
            <p className="text-xs text-muted-foreground">
              {providerDisplayNames[provider]} runs through a personal virtual
              key — connect your own account below.
            </p>
          ) : (
            <>
              <Tabs
                value={proxyAuth}
                onValueChange={(v) => setProxyAuth(v as ConnectProxyAuth)}
              >
                <TabsList>
                  <TabsTrigger value="provider-key">
                    Your provider key
                  </TabsTrigger>
                  <TabsTrigger value="virtual-key">Virtual key</TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">
                {proxyAuth === "provider-key"
                  ? "Passthrough — the command only rewires the base URL, so you reuse your own API key or existing subscription (e.g. Claude or ChatGPT plan)."
                  : providers.length === 0
                    ? "No provider has a key to mint a virtual key from. Add a provider key, or use your provider key."
                    : "A virtual key is created for you and wired into the command."}
              </p>
            </>
          )}
        </div>
      </EditorField>
    </div>
  ) : null;

  const skillsEditor = (
    <label
      className="flex items-center gap-2 text-sm"
      htmlFor="connect-include-skills"
    >
      <Checkbox
        id="connect-include-skills"
        checked={includeSkills}
        onCheckedChange={(checked) => setSkillsOptOut(checked !== true)}
      />
      Install {totalSkills} shared skill{totalSkills === 1 ? "" : "s"}
    </label>
  );

  // Why no provider can be offered for a virtual key: name the providers the
  // client actually supports so the user knows what would need a key.
  const supportedNames = supportedProviders.map((p) => providerDisplayNames[p]);
  const noVirtualKeyMessage =
    supportedNames.length === 1
      ? `${client.label} only routes ${supportedNames[0]}, which has no key configured for a virtual key — switch to your provider key.`
      : `None of ${client.label}'s providers have a key configured for a virtual key — switch to your provider key.`;

  if (!hasAnything) {
    return (
      <WizardStep n={2} title="Review the setup" last>
        <NothingToConnectPanel />
      </WizardStep>
    );
  }

  return (
    <>
      <WizardStep n={2} title="Review the setup">
        <ul className="grid gap-2">
          {gateway && (
            <SummaryRow
              editable={!!gatewayEditor}
              isEditing={editing === "gateway"}
              onToggle={() => toggleEdit("gateway")}
              editor={gatewayEditor}
              changeTestId="connect-change-gateway"
            >
              Connect{" "}
              <ResourceLink href="/mcp/gateways">{gateway.name}</ResourceLink>{" "}
              for tools
            </SummaryRow>
          )}
          {proxy && (
            <SummaryRow
              done={proxyActive}
              editable
              isEditing={editing === "proxy"}
              onToggle={() => toggleEdit("proxy")}
              editor={proxyEditor}
              changeTestId="connect-change-proxy"
            >
              {!provider ? (
                noVirtualKeyMessage
              ) : proxyAuth === "virtual-key" ? (
                <>
                  Route{" "}
                  <span className="font-medium text-foreground">
                    {providerDisplayNames[provider]}
                  </span>{" "}
                  through{" "}
                  <ResourceLink href="/llm/proxies">{proxy.name}</ResourceLink>{" "}
                  using{" "}
                  <span className="font-medium text-foreground">
                    a virtual key
                  </span>
                </>
              ) : (
                <>
                  Passthrough to{" "}
                  <span className="font-medium text-foreground">
                    {providerDisplayNames[provider]}
                  </span>{" "}
                  through{" "}
                  <ResourceLink href="/llm/proxies">{proxy.name}</ResourceLink>{" "}
                  using{" "}
                  <span className="font-medium text-foreground">
                    your provider key
                  </span>{" "}
                  <RecommendationChip>
                    Good for reusing a subscription
                  </RecommendationChip>
                </>
              )}
            </SummaryRow>
          )}
          {skillsEligible && (
            <SummaryRow
              done={includeSkills}
              editable
              isEditing={editing === "skills"}
              onToggle={() => toggleEdit("skills")}
              editor={skillsEditor}
              changeTestId="connect-change-skills"
            >
              {includeSkills ? (
                <>
                  Install{" "}
                  <ResourceLink href="/agents/skills">
                    {totalSkills} shared skill{totalSkills === 1 ? "" : "s"}
                  </ResourceLink>
                </>
              ) : (
                "Shared skills not installed"
              )}
            </SummaryRow>
          )}
          {showEndpoint && (
            <SummaryRow
              editable
              isEditing={editing === "endpoint"}
              onToggle={() => toggleEdit("endpoint")}
              editor={endpointEditor}
              changeTestId="connect-change-endpoint"
            >
              Reach the gateway and proxy at{" "}
              <span className="font-medium text-foreground">{baseUrl}</span>
            </SummaryRow>
          )}
        </ul>
      </WizardStep>

      <WizardStep n={3} title="Run this command" last>
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
            {providers.length > 1 && proxyActive && (
              <div className="flex items-center gap-1 border-b border-[#1f2937] px-3">
                {providers.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onProviderSelect(p)}
                    className={cn(
                      "border-b-2 px-2.5 py-2.5 font-mono text-xs transition-colors",
                      p === provider
                        ? "border-white font-semibold text-white"
                        : "border-transparent text-[#9ca3af] hover:text-white",
                    )}
                  >
                    {providerDisplayNames[p]}
                  </button>
                ))}
              </div>
            )}
            {needsPerUserConnect && provider ? (
              <PerUserConnectGate
                providerLabel={providerDisplayNames[provider]}
                pending={createPerUserKey.isPending}
                onToken={async (token) => {
                  try {
                    await createPerUserKey.mutateAsync({
                      name: providerDisplayNames[provider],
                      provider,
                      apiKey: token,
                      scope: "personal",
                    });
                    // availableKeys invalidates → the command auto-generates.
                  } catch {
                    // handleApiError already surfaced the failure (e.g. no seat)
                  }
                }}
              />
            ) : (
              <CommandLine
                command={result?.command ?? null}
                pending={isPending || (!result && !failed)}
                failed={failed}
                onRetry={() => runGeneration(inputsKey)}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="max-w-2xl">
              One-time command, expires in 15 minutes · macOS &amp; Linux only
              (not Windows) · it edits your client config in place and
              isn&apos;t undone automatically — revert manually if you need to.
            </span>
            <button
              type="button"
              onClick={() => runGeneration(inputsKey)}
              disabled={isPending}
              data-testid="connect-regenerate-command"
              className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw className="size-3" />
              Regenerate
            </button>
          </div>
        </div>
      </WizardStep>
    </>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

function CommandLine({
  command,
  pending,
  failed,
  onRetry,
}: {
  command: string | null;
  pending: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (!command) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1600);
  }, [command]);

  if (failed) {
    return (
      <div className="flex items-center gap-3 px-5 py-4 font-mono text-[13px] text-[#f87171]">
        Couldn't generate the command.
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 border-[#1f2937] bg-transparent text-xs text-[#e5e7eb] hover:bg-[#1f2937] hover:text-white"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (pending || !command) {
    return (
      <div className="flex items-center gap-2.5 px-5 py-4 font-mono text-[13px] text-[#9ca3af]">
        <Loader2 className="size-3.5 animate-spin" />
        Generating command…
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy to clipboard"
        className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
      >
        {copied ? (
          <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" strokeWidth={2} />
        )}
      </button>
      <pre className="m-0 overflow-x-auto px-5 py-4 pr-12 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
        {command}
      </pre>
    </div>
  );
}

/**
 * Shown in place of the command when a per-user provider (GitHub Copilot) is
 * selected but the user hasn't connected their own account yet. Connecting
 * creates their personal key; the command then auto-generates.
 */
function PerUserConnectGate({
  providerLabel,
  pending,
  onToken,
}: {
  providerLabel: string;
  pending: boolean;
  onToken: (token: string) => void | Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-[13px] text-[#e5e7eb]">
        Connect your {providerLabel} account to generate the command — it runs
        through your own personal virtual key, so your token never leaves the
        server.
      </p>
      <div>
        <GithubCopilotSignIn disabled={pending} onToken={onToken} />
      </div>
    </div>
  );
}

/**
 * One review line: a status icon, the summary text, and (when there's a real
 * choice) an inline "Change" that expands the row's own editor right below it.
 */
function SummaryRow({
  children,
  done = true,
  editable = false,
  isEditing = false,
  onToggle,
  editor,
  changeTestId,
}: {
  children: React.ReactNode;
  /** Green check vs. muted "not included" indicator. */
  done?: boolean;
  editable?: boolean;
  isEditing?: boolean;
  onToggle?: () => void;
  editor?: React.ReactNode;
  changeTestId?: string;
}) {
  return (
    <li className="text-sm text-muted-foreground">
      <div className="flex items-start gap-2">
        {done ? (
          <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
        )}
        <span>
          {children}
          {editable && (
            <>
              {" "}
              <button
                type="button"
                onClick={onToggle}
                data-testid={changeTestId}
                className="text-xs text-muted-foreground/70 hover:text-foreground hover:underline"
              >
                {isEditing ? "Done" : "Change"}
              </button>
            </>
          )}
        </span>
      </div>
      {isEditing && editor && (
        <div className="ml-6 mt-2 max-w-md rounded-lg border bg-muted/20 p-3">
          {editor}
        </div>
      )}
    </li>
  );
}

/** Bold, underlined link to the underlying resource (gateway/proxy/skills). */
function ResourceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground"
    >
      {children}
    </Link>
  );
}

/** Small positive chip used to flag a recommended option. */
function RecommendationChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="ml-1 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
      {children}
    </span>
  );
}

/** label + control row inside an inline editor. */
function EditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid items-center gap-2 sm:grid-cols-[88px_1fr]">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function BaseUrlSelect({
  candidateUrls,
  metadata,
  value,
  onChange,
}: {
  candidateUrls: readonly string[];
  metadata: readonly ConnectionBaseUrl[] | null | undefined;
  value: string;
  onChange: (url: string) => void;
}) {
  const metaByUrl = new Map((metadata ?? []).map((m) => [m.url, m] as const));
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
        {candidateUrls.map((url) => {
          const description = metaByUrl.get(url)?.description ?? "";
          return (
            <SelectItem key={url} value={url}>
              <span className="flex min-w-0 items-center gap-2">
                <code className="shrink-0 font-mono text-xs">{url}</code>
                {description && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {description}
                  </span>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function NothingToConnectPanel() {
  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      Nothing to connect yet. Create an{" "}
      <Link href="/mcp/gateways" className="underline hover:text-foreground">
        MCP gateway
      </Link>{" "}
      or an{" "}
      <Link href="/llm/proxies" className="underline hover:text-foreground">
        LLM proxy
      </Link>{" "}
      first.
    </div>
  );
}
