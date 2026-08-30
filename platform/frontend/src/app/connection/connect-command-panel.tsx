"use client";

import {
  DEFAULT_MODELS,
  providerRequiresPerUserCredential,
  type SupportedProvider,
} from "@archestra/shared";
import { Check, KeyRound, PackageOpen, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AgentSelector,
  type AgentSelectorAgent,
} from "@/components/agent-selector";
import { CreditWarningNotice } from "@/components/connection/credit-warning-notice";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { GithubCopilotSignIn } from "@/components/github-copilot-sign-in";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WizardStep } from "@/components/wizard-step";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { type Bundle, useBundles } from "@/lib/bundle.query";
import { formatBundleCapabilitySummary } from "@/lib/bundle-capabilities";
import { useConfig } from "@/lib/config/config.query";
import {
  type CreateConnectionSetupBody,
  type CreateConnectionSetupResult,
  useCreateConnectionSetup,
} from "@/lib/connection-setup.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmModelsByProvider } from "@/lib/llm-models.query";
import {
  useAvailableLlmProviderApiKeys,
  useCreateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { type PluginListItem, usePlugins } from "@/lib/plugins/plugin.query";
import { cn } from "@/lib/utils";
import { type ConnectClient, FINISH_OAUTH_FLOW_TITLE } from "./clients";
import {
  type ConnectionBaseUrl,
  deriveMcpServerName,
} from "./connection-flow.utils";
import { GatewayServersSummary } from "./gateway-servers-summary";
import { OsLogos } from "./os-logos";
import {
  type ConnectPlatformOption,
  detectPlatform,
  platformLabels,
  toPlatformOption,
} from "./platform.utils";
import { ConnectionPlatformToggle } from "./platform-select";
import { SetupCommandLine } from "./setup-command-line";
import { SetupSummaryRow } from "./setup-summary-row";
import {
  type ConnectSkill,
  SkillsMarketplaceStep,
  useAllSkills,
  useSkillsMarketplaceVisible,
} from "./skills-marketplace-step";
import { TerminalBlock } from "./terminal-block";

type ScriptClientId = CreateConnectionSetupBody["clientId"];
type ConnectProxyAuth = NonNullable<CreateConnectionSetupBody["proxyAuth"]>;
type EditableRow =
  | "endpoint"
  | "gateway"
  | "proxy"
  | "model"
  | "skills"
  | "plugins"
  | "platform";

type ResolvedBundle = Bundle;

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
 * Whether skills can ride along in the setup command: the caller can read
 * skills, and there is at least one to install. Reading is the bar because the
 * command registers the deployment's shared marketplace URL, which serves each
 * person exactly the skills they may already read — so a member installs with
 * the same one command an admin gets.
 *
 * The list is surfaced so the review step can name what will be installed. It
 * is deliberately not a per-skill choice: the shared URL stays current and
 * carries everything shared with you, so a checkbox per skill would claim
 * control the install does not have. Sharing a fixed subset is what a snapshot
 * link is for.
 */
function useConnectSkills(llmProxyId: string | null): {
  eligible: boolean;
  skills: ConnectSkill[];
} {
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  // Skills are environment-scoped: with a proxy selected, only skills in that
  // proxy's environment are connectable.
  const { data: skills } = useAllSkills({
    enabled: canReadSkills === true,
    forAgentId: llmProxyId,
  });
  return {
    eligible: canReadSkills === true && (skills ?? []).length > 0,
    skills: skills ?? [],
  };
}

interface ConnectCommandPanelProps {
  client: ConnectClient;
  /** null when the user can't read MCP gateways. */
  mcpGateways: AgentSelectorAgent[] | null;
  /** Whether accessible gateways are still loading. */
  mcpGatewaysPending?: boolean;
  mcpGatewayId: string | null;
  onMcpGatewaySelect: (id: string) => void;
  /** The org's single LLM Proxy id; null when the user can't read it (or it hasn't loaded). */
  llmProxyId: string | null;
  /** When null/undefined: all providers allowed. Otherwise: only these. */
  shownProviders?: readonly SupportedProvider[] | null;
  /** Provider pinned in the URL (bookmarkable); falls back to the first supported. */
  urlProvider: SupportedProvider | null;
  onProviderSelect: (provider: SupportedProvider) => void;
  baseUrl: string;
  candidateBaseUrls: readonly string[];
  baseUrlMetadata: readonly ConnectionBaseUrl[] | null | undefined;
  onBaseUrlChange: (url: string) => void;
  /** A Bundle selected by an install link, applied once after bundles load. */
  initialBundleId?: string;
  /** Clears the deep-link selection after it is applied or found unavailable. */
  onInitialBundleHandled?: () => void;
}

/**
 * The whole "step 2" of the wizard: a terminal block whose one-time setup
 * command regenerates itself whenever a selection changes — no explicit
 * generate click. Defaults cover everything (default gateway, the LLM Proxy,
 * first supported provider, skills included); the rare overrides live behind
 * the Options disclosure.
 */
export function ConnectCommandPanel({
  client,
  mcpGateways,
  mcpGatewaysPending,
  mcpGatewayId,
  onMcpGatewaySelect,
  llmProxyId,
  shownProviders,
  urlProvider,
  onProviderSelect,
  baseUrl,
  candidateBaseUrls,
  baseUrlMetadata,
  onBaseUrlChange,
  initialBundleId,
  onInitialBundleHandled,
}: ConnectCommandPanelProps) {
  const { eligible: skillsEligible, skills: allSkills } =
    useConnectSkills(llmProxyId);
  // Providers are named the way this organization names them, so a renamed
  // provider reads the same here as in the model-provider settings.
  const providerCatalog = useModelProviderCatalog();
  // Skill selection: `null` means "all skills" (the default, and it keeps
  // including skills created later). Once the user touches any checkbox it
  // becomes an explicit snapshot of chosen ids — so an opt-out (empty set)
  // stays opted out even if the skill list refetches with new skills, and a
  // custom pick never silently gains a skill the user never saw. The set is
  // always intersected with the current list, so deleted skills drop out
  // cleanly.
  const [selectedSkillIds, setSelectedSkillIds] =
    useState<ReadonlySet<string> | null>(null);
  // Plugin selection mirrors Skills: null means every compatible plugin;
  // touching a checkbox freezes an explicit id set so later refetches cannot
  // silently add a plugin the user did not review.
  const [pluginSelections, setPluginSelections] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(new Map());
  const [appliedBundle, setAppliedBundle] = useState<{
    clientId: string;
    bundleId: string;
    selectedOptionalLocalMcpServerIds: string[];
  } | null>(null);
  const selectedSkills = useMemo(
    () =>
      selectedSkillIds === null
        ? allSkills
        : allSkills.filter((s) => selectedSkillIds.has(s.id)),
    [allSkills, selectedSkillIds],
  );
  const includeSkills = skillsEligible && selectedSkills.length > 0;

  const {
    data: configData,
    isPending: configPending,
    isError: configError,
  } = useConfig();
  const pluginsEnabled = !configError && configData?.features.plugins === true;
  const bundlesEnabled = !configError && configData?.features.bundles === true;
  const { data: managedBundles = [], isPending: bundlesPending } = useBundles({
    enabled: bundlesEnabled,
  });
  const initialBundleHandledRef = useRef<string | null>(null);
  const { data: canAdminPlugins, isPending: pluginsPermissionPending } =
    useHasPermissions({
      plugin: ["read", "admin"],
    });
  const pluginsQueryEnabled =
    pluginsEnabled === true && canAdminPlugins === true;
  const { data: allPlugins, isPending: pluginsPending } =
    usePlugins(pluginsQueryEnabled);
  const plugins = useMemo(
    () =>
      (allPlugins ?? []).filter(
        (plugin) =>
          plugin.clientType === client.id &&
          plugin.enabled &&
          plugin.approvedContentHash === plugin.contentHash,
      ),
    [allPlugins, client.id],
  );
  const pluginsLoading =
    configPending ||
    (pluginsEnabled && pluginsPermissionPending) ||
    (pluginsQueryEnabled && pluginsPending);

  // Toggle one skill, snapshotting the current selection into an explicit set
  // on first interaction (null → all ids, then add/remove the toggled one).
  const [proxyAuth, setProxyAuth] = useState<ConnectProxyAuth>("provider-key");
  // Target OS for the generated command. Auto-detected from the browser after
  // mount (kept off the initial render to avoid an SSR/hydration mismatch); the
  // user can override it in the review step.
  const [platform, setPlatform] = useState<ConnectPlatformOption>("macos");
  useEffect(() => {
    setPlatform(toPlatformOption(detectPlatform()));
  }, []);
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

  // The Copilot CLI refuses to launch a BYOK provider without an explicit
  // COPILOT_MODEL, so the review step surfaces the model as a reviewable
  // choice instead of hard-wiring a default. null = the provider's default;
  // reset when the provider changes so a model picked for one provider never
  // leaks onto another. Options come from the org's synced model list; with
  // none synced for the provider, a free-text field takes any model id.
  const isCopilotClient = client.id === "copilot-cli";
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider is the reset trigger
  useEffect(() => setModelChoice(null), [provider]);
  const { modelsByProvider } = useLlmModelsByProvider();
  const effectiveModel =
    isCopilotClient && provider
      ? (modelChoice ?? DEFAULT_MODELS[provider])
      : null;
  const modelOptions = useMemo(() => {
    if (!isCopilotClient || !provider) return [];
    const ids = (modelsByProvider[provider] ?? []).map((m) => m.id);
    // the current value stays selectable even when it's not in the synced list
    return Array.from(new Set(effectiveModel ? [effectiveModel, ...ids] : ids));
  }, [isCopilotClient, provider, modelsByProvider, effectiveModel]);

  // Per-user providers always use virtual-key auth (no passthrough tab). This
  // is derived rather than written back into `proxyAuth`: overwriting the
  // stored choice would flip the panel into virtual-key mode for good, which
  // filters keyless providers out of the tabs — so picking GitHub Copilot
  // once would hide the other providers until the next page load.
  const effectiveProxyAuth: ConnectProxyAuth = providerIsPerUser
    ? "virtual-key"
    : proxyAuth;

  const gateway = mcpGateways?.find((g) => g.id === mcpGatewayId) ?? null;
  // The LLM Proxy may be available without a usable provider (e.g. virtual-key
  // mode with no configured providers); keep it for the row/editor, but it
  // only joins the command when a provider is also resolved.
  const hasProxy = llmProxyId !== null;
  const proxyActive = !!(llmProxyId && provider);
  // Virtual-key auth was chosen, but nothing can back it: the client routes only
  // providers with no configured key (and none are per-user), so no virtual key
  // can be minted. Emitting the script anyway would silently drop the inference
  // proxy, so — like the per-user connect gate — step 3 gates on adding a key
  // instead of shipping a half-configured command.
  const virtualKeyUnbacked =
    hasProxy && !provider && proxyAuth === "virtual-key";
  const requiredPluginPlatform = platform === "windows" ? "windows" : "posix";
  // The selection follows the client across OS changes. Compatibility is a
  // filter, not permission to re-add something the user explicitly removed.
  const pluginSelectionContext = client.id;
  const selectedPluginIds =
    pluginSelections.get(pluginSelectionContext) ?? null;
  const compatiblePlugins = plugins.filter((plugin) =>
    plugin.supportedPlatforms.includes(requiredPluginPlatform),
  );
  const selectedPlugins =
    selectedPluginIds === null
      ? compatiblePlugins
      : compatiblePlugins.filter((plugin) => selectedPluginIds.has(plugin.id));
  const incompatiblePlugins = plugins.filter(
    (plugin) => !plugin.supportedPlatforms.includes(requiredPluginPlatform),
  );
  const availableSkillIds = new Set(allSkills.map((skill) => skill.id));
  const availablePluginIds = new Set(
    compatiblePlugins.map((plugin) => plugin.id),
  );
  const bundles: ResolvedBundle[] = bundlesEnabled
    ? managedBundles.map((bundle) => ({
        ...bundle,
        skillIds: bundle.skillIds.filter((id) => availableSkillIds.has(id)),
        pluginIds: bundle.pluginIds.filter((id) => availablePluginIds.has(id)),
        localMcpServers: bundle.localMcpServers ?? [],
      }))
    : [];
  const activeBundleId =
    appliedBundle?.clientId === client.id ? appliedBundle.bundleId : null;
  const activeBundle =
    bundles.find((bundle) => bundle.id === activeBundleId) ?? null;
  const dismissInitialBundle = useCallback(() => {
    if (!initialBundleId) return;
    initialBundleHandledRef.current = initialBundleId;
    onInitialBundleHandled?.();
  }, [initialBundleId, onInitialBundleHandled]);
  const applyBundle = useCallback(
    (bundle: ResolvedBundle) => {
      setSelectedSkillIds(new Set(bundle.skillIds));
      setPluginSelections((current) =>
        new Map(current).set(pluginSelectionContext, new Set(bundle.pluginIds)),
      );
      setAppliedBundle({
        clientId: client.id,
        bundleId: bundle.id,
        selectedOptionalLocalMcpServerIds: bundle.localMcpServers
          .filter((server) => server.optional)
          .map((server) => server.id),
      });
      if (
        bundle.mcpGatewayId &&
        mcpGateways?.some((candidate) => candidate.id === bundle.mcpGatewayId)
      ) {
        onMcpGatewaySelect(bundle.mcpGatewayId);
      }
      setEditing(null);
    },
    [client.id, mcpGateways, onMcpGatewaySelect, pluginSelectionContext],
  );
  useEffect(() => {
    if (
      !bundlesEnabled ||
      !initialBundleId ||
      bundlesPending ||
      initialBundleHandledRef.current === initialBundleId
    ) {
      return;
    }

    const initialBundle = bundles.find(
      (bundle) => bundle.id === initialBundleId,
    );
    if (initialBundle?.mcpGatewayId && mcpGatewaysPending) return;

    dismissInitialBundle();
    if (initialBundle) applyBundle(initialBundle);
  }, [
    applyBundle,
    bundles,
    bundlesEnabled,
    bundlesPending,
    dismissInitialBundle,
    initialBundleId,
    mcpGatewaysPending,
  ]);
  const handleBundleSelect = (bundle: ResolvedBundle) => {
    dismissInitialBundle();
    applyBundle(bundle);
  };
  const handleMcpGatewaySelect = (id: string) => {
    dismissInitialBundle();
    onMcpGatewaySelect(id);
  };
  const handleProviderSelect = (provider: SupportedProvider) => {
    dismissInitialBundle();
    onProviderSelect(provider);
  };
  const handleBaseUrlChange = (url: string) => {
    dismissInitialBundle();
    onBaseUrlChange(url);
  };
  const toggleOptionalLocalMcpServer = (serverId: string, checked: boolean) => {
    dismissInitialBundle();
    setAppliedBundle((current) => {
      if (!current || current.clientId !== client.id) return current;
      const selected = new Set(current.selectedOptionalLocalMcpServerIds);
      if (checked) selected.add(serverId);
      else selected.delete(serverId);
      return {
        ...current,
        selectedOptionalLocalMcpServerIds: [...selected].sort(),
      };
    });
  };
  const togglePlugin = useCallback(
    (pluginId: string, checked: boolean) => {
      dismissInitialBundle();
      setAppliedBundle(null);
      setPluginSelections((current) => {
        const currentIds = current.get(pluginSelectionContext) ?? null;
        const next = new Set(currentIds ?? plugins.map((plugin) => plugin.id));
        if (checked) next.add(pluginId);
        else next.delete(pluginId);
        return new Map(current).set(pluginSelectionContext, next);
      });
    },
    [dismissInitialBundle, plugins, pluginSelectionContext],
  );
  const hasRunnableAnything = Boolean(
    gateway ||
      proxyActive ||
      includeSkills ||
      selectedPlugins.length ||
      (activeBundle &&
        ["claude-code", "cursor"].includes(client.id) &&
        activeBundle.localMcpServers.some(
          (server) =>
            !server.optional ||
            appliedBundle?.selectedOptionalLocalMcpServerIds.includes(
              server.id,
            ),
        )),
  );
  const hasAnything = Boolean(hasRunnableAnything || plugins.length > 0);

  // The setup command only registers the MCP gateway (`claude mcp add`); the
  // gateway authenticates over OAuth, so the user still finishes the handshake
  // in their client. Surface that as an explicit final step — mirrors the
  // Claude Desktop panel's "Finish the OAuth flow" step. The gateway is the
  // thing being authorized, so the step is gateway-gated.
  const showOAuthStep =
    client.id === "claude-code" && !!gateway && !virtualKeyUnbacked;
  // The script installs skills itself for everyone who can read them, so the
  // wizard never grows an extra step here. The marketplace step appears only
  // when there is no script to carry them: nothing to connect at all (below),
  // or a client without a generated command.
  const skillsStepAvailable = useSkillsMarketplaceVisible(client);
  const appName = useAppName();
  // The exact name the script registers the gateway under — referenced in the
  // OAuth step so the user can find it in the `claude /mcp` list.
  const oauthServerName = deriveMcpServerName({
    gatewayName: gateway?.name ?? "",
    appName,
  });

  // Passthrough setups also get a personal passthrough virtual key wired into the
  // command (best-effort: only when the user can mint one) so requests are
  // attributed to the user. Applies to Claude Code (Anthropic subscription or
  // the user's own Bedrock credentials) and Codex (the user's own OpenAI key).
  // Used purely to tailor the passthrough description copy — the backend
  // provisions it automatically; there is no separate UI choice.
  const { data: canAttribute } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const passthroughAttributes =
    canAttribute === true &&
    ((client.id === "claude-code" &&
      (provider === "anthropic" || provider === "bedrock")) ||
      (client.id === "codex" && provider === "openai"));

  const { mutateAsync: createSetup, isPending } = useCreateConnectionSetup();
  // Creating the personal key invalidates the available-keys query, so once the
  // user connects, `configuredProviders` updates and the command auto-generates.
  const createPerUserKey = useCreateLlmProviderApiKey();
  // Virtual keys are minted from a provider key. When none of the client's
  // providers has one, offer to add it inline (gated on the create permission);
  // the create mutation invalidates the available-keys query, so this section
  // re-resolves the moment the key lands.
  const { data: canCreateProviderKey } = useHasPermissions({
    llmProviderApiKey: ["create"],
  });
  const [showAddProviderKey, setShowAddProviderKey] = useState(false);
  const [result, setResult] = useState<CreateConnectionSetupResult | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  // One key per distinct setup payload. The effect below regenerates when it
  // changes; the ref guards against an older in-flight response overwriting a
  // newer one.
  const inputsKey = JSON.stringify({
    clientId: client.id,
    platform,
    baseUrl,
    gatewayId: gateway?.id ?? null,
    proxyId: proxyActive ? llmProxyId : null,
    provider: proxyActive ? provider : null,
    proxyAuth: proxyActive ? effectiveProxyAuth : null,
    model: proxyActive ? effectiveModel : null,
    bundleId: activeBundleId,
    selectedOptionalLocalMcpServerIds:
      appliedBundle?.clientId === client.id
        ? appliedBundle.selectedOptionalLocalMcpServerIds
        : [],
    // Sorted so reorderings of the same selection don't regenerate.
    skillIds:
      activeBundleId === null && includeSkills
        ? selectedSkills.map((s) => s.id).sort()
        : null,
    pluginIds:
      activeBundleId === null
        ? selectedPlugins.map((plugin) => plugin.id).sort()
        : null,
  });
  const latestKeyRef = useRef(inputsKey);
  latestKeyRef.current = inputsKey;

  const runGeneration = useCallback(
    async (key: string) => {
      const inputs = JSON.parse(key) as {
        clientId: ScriptClientId;
        platform: ConnectPlatformOption;
        baseUrl: string;
        gatewayId: string | null;
        proxyId: string | null;
        provider: SupportedProvider | null;
        proxyAuth: ConnectProxyAuth | null;
        model: string | null;
        bundleId: string | null;
        selectedOptionalLocalMcpServerIds: string[];
        skillIds: string[] | null;
        pluginIds: string[] | null;
      };

      let skills: CreateConnectionSetupBody["skills"];
      if (inputs.skillIds && inputs.skillIds.length > 0) {
        // ttlDays is null because the marketplace the client clones from must
        // outlive the one-time setup token. It only applies on the snapshot
        // path (a setup that also delivers plugins); the shared marketplace URL
        // this normally renders has no expiry to set.
        skills = { skillIds: inputs.skillIds, ttlDays: null };
      }
      if (
        !inputs.gatewayId &&
        !inputs.proxyId &&
        !inputs.bundleId &&
        !skills &&
        (inputs.pluginIds?.length ?? 0) === 0
      ) {
        return;
      }

      const created = await createSetup({
        clientId: inputs.clientId,
        platform: inputs.platform,
        baseUrl: inputs.baseUrl,
        mcpGatewayId: inputs.gatewayId ?? undefined,
        llmProxyId: inputs.proxyId ?? undefined,
        provider: inputs.provider ?? undefined,
        proxyAuth: inputs.proxyAuth ?? undefined,
        model: inputs.model ?? undefined,
        ...(inputs.bundleId
          ? {
              bundleId: inputs.bundleId,
              selectedOptionalLocalMcpServerIds:
                inputs.selectedOptionalLocalMcpServerIds,
            }
          : { skills, pluginIds: inputs.pluginIds ?? [] }),
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
    // Don't try to generate a command until the setup can actually be produced:
    // not before a per-user account is connected, and not for a virtual key that
    // has no provider key to mint from — either way the backend would reject it
    // (or the script would silently drop the proxy).
    if (
      !hasRunnableAnything ||
      pluginsLoading ||
      needsPerUserConnect ||
      virtualKeyUnbacked
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void runGeneration(inputsKey);
    }, 350);
    return () => clearTimeout(timer);
  }, [
    inputsKey,
    hasRunnableAnything,
    pluginsLoading,
    needsPerUserConnect,
    virtualKeyUnbacked,
    runGeneration,
  ]);

  // Each summary line owns its inline editor. A line is editable only when it
  // has a real choice (e.g. more than one gateway); otherwise no "Change".
  const canPickGateway =
    !!gateway && mcpGateways !== null && mcpGateways.length > 1;
  const gatewayEditor = canPickGateway ? (
    <div className="grid gap-3">
      {mcpGateways && mcpGateways.length > 1 && gateway && (
        <EditorField label="Gateway">
          <AgentSelector
            mode="single"
            flat
            className="w-full"
            agents={mcpGateways}
            value={gateway.id}
            onValueChange={handleMcpGatewaySelect}
            placeholder="Select gateway"
            searchPlaceholder="Search gateways…"
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
        onChange={handleBaseUrlChange}
      />
    </EditorField>
  );

  const platformEditor = (
    <EditorField label="Platform">
      <ConnectionPlatformToggle
        value={platform}
        onValueChange={(value) => {
          dismissInitialBundle();
          setAppliedBundle(null);
          setPlatform(value);
        }}
        ariaLabel="Select a platform"
        dataTestId="connect-platform-select"
      />
    </EditorField>
  );

  // A virtual key is minted from a key for one of the providers THIS client
  // routes through the proxy (e.g. Claude Code → Anthropic/Bedrock), not from
  // any provider key you happen to have. Naming them keeps "no key" from
  // reading as "you have no keys at all".
  const supportedNames = supportedProviders.map((p) =>
    providerCatalog.label(p),
  );
  const noVirtualKeyReason =
    supportedNames.length === 0
      ? "None of this client's providers has a key to mint a virtual key from."
      : supportedNames.length === 1
        ? `${client.label} routes ${supportedNames[0]}, which has no key to mint a virtual key from.`
        : `${client.label} routes ${formatList(supportedNames)}, none of which has a key to mint a virtual key from.`;
  // Brand the "add a key" CTA to the one provider a single-provider client
  // routes (e.g. Codex → OpenAI), matching how the per-user gate is branded to
  // its client. With several providers there's nothing single to name, so the
  // wording stays generic.
  const soleProvider =
    supportedProviders.length === 1 ? supportedProviders[0] : null;
  const addKeyPhrase = soleProvider
    ? `${indefiniteArticle(providerCatalog.label(soleProvider))} ${providerCatalog.label(soleProvider)} key`
    : "a provider key";
  const providerKeyDialogDescription =
    supportedNames.length === 0
      ? "Add a provider API key so a virtual key can be minted from it."
      : `Add a provider API key so a virtual key can be minted from it. ${client.label} routes ${formatList(supportedNames)}, so a key for one of those unlocks the virtual-key option for this client.`;

  // A per-user provider (GitHub Copilot) forces virtual-key auth, so switching
  // the toggle back to passthrough while it's selected would re-force virtual
  // key and appear to do nothing. Move to the first passthrough-capable provider
  // as well, so the toggle can never strand the user in the per-user state.
  const handleProxyAuthChange = (value: string) => {
    dismissInitialBundle();
    const next = value as ConnectProxyAuth;
    setProxyAuth(next);
    if (next === "provider-key" && providerIsPerUser) {
      const firstPassthrough = supportedProviders.find(
        (p) => !providerRequiresPerUserCredential(p),
      );
      if (firstPassthrough) handleProviderSelect(firstPassthrough);
    }
  };

  const proxyEditor = hasProxy ? (
    <div className="grid gap-3">
      <EditorField label="Auth">
        <div className="grid gap-1.5">
          {/* The toggle stays visible even for a per-user provider (GitHub
              Copilot), which forces virtual-key auth. Hiding it there stranded
              the user in virtual-key mode with no way back;
              handleProxyAuthChange moves off the per-user provider when
              switching to passthrough, so the choice sticks. */}
          <Tabs
            value={effectiveProxyAuth}
            onValueChange={handleProxyAuthChange}
          >
            <TabsList>
              <TabsTrigger value="provider-key">Your provider key</TabsTrigger>
              <TabsTrigger value="virtual-key">Virtual key</TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {effectiveProxyAuth === "provider-key" ? (
              passthroughAttributes ? (
                <span>
                  Only the base URL changes: requests keep using your own API
                  key or subscription, and a personal passthrough virtual key in
                  the command attributes them to you.
                </span>
              ) : (
                <span>
                  Only the base URL changes: requests keep using your own API
                  key or subscription (e.g. a Claude or ChatGPT plan).
                </span>
              )
            ) : providerIsPerUser && provider ? (
              <span>
                {`${providerCatalog.label(provider)} runs through a personal virtual key — connect your own account below.`}
              </span>
            ) : providers.length === 0 ? (
              canCreateProviderKey ? (
                <>
                  <span>{noVirtualKeyReason} </span>
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                    onClick={() => setShowAddProviderKey(true)}
                    data-testid="connect-auth-add-provider-key"
                  >
                    Add {addKeyPhrase}
                  </button>
                  <span> or switch to your provider key.</span>
                </>
              ) : (
                <span>
                  {`${noVirtualKeyReason} Switch to your provider key, or ask an admin to add ${addKeyPhrase}.`}
                </span>
              )
            ) : (
              <span>
                A virtual key is created for you and wired into the command.
              </span>
            )}
          </p>
        </div>
      </EditorField>
    </div>
  ) : null;

  const modelEditor =
    isCopilotClient && provider ? (
      <div className="grid gap-1.5">
        <EditorField label="Model">
          {modelOptions.length > 1 ? (
            <Select
              value={effectiveModel ?? undefined}
              onValueChange={(value) => {
                dismissInitialBundle();
                setModelChoice(value);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={effectiveModel ?? ""}
              onChange={(event) => {
                dismissInitialBundle();
                setModelChoice(event.target.value || null);
              }}
              placeholder="Model id"
            />
          )}
        </EditorField>
        <p className="text-xs text-muted-foreground">
          Applied as COPILOT_MODEL by the setup script — pick a model your{" "}
          {providerCatalog.label(provider)} access serves.
        </p>
      </div>
    ) : null;

  const skillsEditor = (
    <div className="grid gap-2">
      <label
        className="flex items-center gap-2 text-sm font-medium"
        htmlFor="connect-include-skills"
      >
        <Checkbox
          id="connect-include-skills"
          // The direct control remains all-or-nothing. A bundle can provide a
          // fixed subset, which the plugin-bearing snapshot delivery preserves.
          checked={selectedSkills.length > 0}
          onCheckedChange={(checked) => {
            dismissInitialBundle();
            setAppliedBundle(null);
            setSelectedSkillIds(checked === true ? null : new Set());
          }}
        />
        Install shared skills
      </label>
      {llmProxyId !== null && (
        <p className="pl-6 text-xs text-muted-foreground">
          Only skills in the LLM Proxy's environment are listed.
        </p>
      )}
      {selectedSkillIds === null ? (
        <p className="pl-6 text-xs text-muted-foreground">
          Everything shared with you is installed, and stays current as skills
          are added or removed.
        </p>
      ) : (
        <p className="pl-6 text-xs text-muted-foreground">
          The selected bundle installs this fixed skill set. Choose another
          bundle to replace it.
        </p>
      )}
    </div>
  );

  const pluginsEditor =
    compatiblePlugins.length > 0 ? (
      <div className="grid gap-2">
        <label
          className="flex items-center gap-2 text-sm font-medium"
          htmlFor="connect-include-plugins"
        >
          <Checkbox
            id="connect-include-plugins"
            checked={
              selectedPlugins.length === compatiblePlugins.length
                ? true
                : selectedPlugins.length === 0
                  ? false
                  : "indeterminate"
            }
            onCheckedChange={(checked) => {
              dismissInitialBundle();
              setAppliedBundle(null);
              setPluginSelections((current) => {
                const next = new Map(current);
                if (checked === true) next.delete(pluginSelectionContext);
                else next.set(pluginSelectionContext, new Set());
                return next;
              });
            }}
          />
          Install compatible plugins
        </label>
        <ul className="grid max-h-56 gap-1.5 overflow-y-auto pl-6">
          {compatiblePlugins.map((plugin) => (
            <li key={plugin.id}>
              <label
                className="flex items-center gap-2 text-sm"
                htmlFor={`connect-plugin-${plugin.id}`}
              >
                <Checkbox
                  id={`connect-plugin-${plugin.id}`}
                  checked={
                    selectedPluginIds === null ||
                    selectedPluginIds.has(plugin.id)
                  }
                  onCheckedChange={(checked) =>
                    togglePlugin(plugin.id, checked === true)
                  }
                />
                <span>{plugin.displayName}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const noVirtualKeyMessage =
    supportedNames.length === 1
      ? `${client.label} only routes ${supportedNames[0]}, which has no key configured for a virtual key — switch to your provider key.`
      : `None of ${client.label}'s providers have a key configured for a virtual key — switch to your provider key.`;
  const pluginCountLabel =
    selectedPlugins.length === compatiblePlugins.length
      ? `${selectedPlugins.length} plugin${selectedPlugins.length === 1 ? "" : "s"}`
      : `${selectedPlugins.length} of ${compatiblePlugins.length} plugins`;
  const commandStatus = pluginsLoading
    ? "Loading plugins"
    : needsPerUserConnect
      ? `Connect ${provider ? providerCatalog.label(provider) : "your provider"} to generate the setup command`
      : virtualKeyUnbacked
        ? "Add a provider key to generate the setup command"
        : failed
          ? "Setup command generation failed"
          : result
            ? "Setup command ready"
            : hasRunnableAnything
              ? "Generating setup command"
              : "No setup command selected";

  if (!hasAnything) {
    // Nothing to put in a setup command — but skills install from their own
    // marketplace URL, so a caller who can read them still has something to do.
    return (
      <>
        <WizardStep n={2} title="Review the setup" last={!skillsStepAvailable}>
          <NothingToConnectPanel />
        </WizardStep>
        {skillsStepAvailable && (
          <WizardStep n={3} title="Install shared skills" last>
            <SkillsMarketplaceStep client={client} />
          </WizardStep>
        )}
      </>
    );
  }

  return (
    <>
      <WizardStep n={2} title="Review the setup">
        <ul className="grid gap-2">
          {bundles.length > 0 && (
            <li className="mb-2">
              <BundlePicker
                bundles={bundles}
                activeBundleId={activeBundleId}
                mcpGateways={mcpGateways}
                onSelect={handleBundleSelect}
                selectedOptionalLocalMcpServerIds={
                  appliedBundle?.clientId === client.id
                    ? appliedBundle.selectedOptionalLocalMcpServerIds
                    : []
                }
                onToggleOptionalLocalMcpServer={toggleOptionalLocalMcpServer}
              />
            </li>
          )}
          {gateway && (
            <SetupSummaryRow
              editable={!!gatewayEditor}
              isEditing={editing === "gateway"}
              onToggle={() => toggleEdit("gateway")}
              editor={gatewayEditor}
              changeTestId="connect-change-gateway"
              detail={<GatewayServersSummary gatewayId={gateway.id} />}
            >
              Connect{" "}
              <ResourceLink href="/mcp/gateways">{gateway.name}</ResourceLink>{" "}
              for tools
            </SetupSummaryRow>
          )}
          {hasProxy && (
            <SetupSummaryRow
              done={proxyActive}
              editable
              isEditing={editing === "proxy"}
              onToggle={() => toggleEdit("proxy")}
              editor={proxyEditor}
              changeTestId="connect-change-proxy"
            >
              {!provider ? (
                noVirtualKeyMessage
              ) : effectiveProxyAuth === "virtual-key" ? (
                <>
                  Route{" "}
                  <span className="font-medium text-foreground">
                    {providerCatalog.label(provider)}
                  </span>{" "}
                  through{" "}
                  <ResourceLink href="/llm/proxy">the LLM Proxy</ResourceLink>{" "}
                  using{" "}
                  <span className="font-medium text-foreground">
                    a virtual key
                  </span>
                </>
              ) : (
                <>
                  Passthrough to{" "}
                  <span className="font-medium text-foreground">
                    {providerCatalog.label(provider)}
                  </span>{" "}
                  through{" "}
                  <ResourceLink href="/llm/proxy">the LLM Proxy</ResourceLink>{" "}
                  using{" "}
                  <span className="font-medium text-foreground">
                    your provider key
                  </span>{" "}
                  <RecommendationChip>
                    Good for reusing a subscription
                  </RecommendationChip>
                </>
              )}
            </SetupSummaryRow>
          )}
          {isCopilotClient && proxyActive && provider && (
            <SetupSummaryRow
              done
              editable
              isEditing={editing === "model"}
              onToggle={() => toggleEdit("model")}
              editor={modelEditor}
              changeTestId="connect-change-model"
            >
              Run Copilot with{" "}
              <span className="font-medium text-foreground">
                {effectiveModel}
              </span>
            </SetupSummaryRow>
          )}
          {skillsEligible && (
            <SetupSummaryRow
              done={includeSkills}
              editable
              isEditing={editing === "skills"}
              onToggle={() => toggleEdit("skills")}
              editor={skillsEditor}
              changeTestId="connect-change-skills"
              detail={
                includeSkills ? (
                  <SkillNamesLine skills={selectedSkills} />
                ) : undefined
              }
            >
              {includeSkills ? (
                <>
                  <span>Install </span>
                  <ResourceLink href="/skills">
                    <span>
                      <span>{selectedSkills.length} shared skill</span>
                      {selectedSkills.length === 1 ? null : <span>s</span>}
                    </span>
                  </ResourceLink>
                </>
              ) : (
                <span>Shared skills not installed</span>
              )}
            </SetupSummaryRow>
          )}
          {plugins.length > 0 && (
            <SetupSummaryRow
              done={selectedPlugins.length > 0 && client.id !== "cursor"}
              editable={!!pluginsEditor}
              isEditing={editing === "plugins"}
              onToggle={() => toggleEdit("plugins")}
              editor={pluginsEditor}
              changeTestId="connect-change-plugins"
              detail={
                <PluginsDetail
                  plugins={selectedPlugins}
                  incompatiblePlugins={incompatiblePlugins}
                  clientId={client.id as ScriptClientId}
                  platform={platform}
                />
              }
            >
              {compatiblePlugins.length === 0 ? (
                <span>
                  No compatible plugins for {platformLabels[platform]}
                </span>
              ) : selectedPlugins.length === 0 ? (
                <span>Plugins not installed</span>
              ) : client.id === "cursor" ? (
                <span>
                  Install{" "}
                  <ResourceLink href="/plugins">
                    {pluginCountLabel}
                  </ResourceLink>{" "}
                  manually
                </span>
              ) : (
                <span>
                  Install{" "}
                  <ResourceLink href="/plugins">
                    {pluginCountLabel}
                  </ResourceLink>
                </span>
              )}
            </SetupSummaryRow>
          )}
          {showEndpoint && (
            <SetupSummaryRow
              editable
              isEditing={editing === "endpoint"}
              onToggle={() => toggleEdit("endpoint")}
              editor={endpointEditor}
              changeTestId="connect-change-endpoint"
            >
              Reach the gateway and proxy at{" "}
              <span className="font-medium text-foreground">{baseUrl}</span>
            </SetupSummaryRow>
          )}
          <SetupSummaryRow
            editable
            isEditing={editing === "platform"}
            onToggle={() => toggleEdit("platform")}
            editor={platformEditor}
            changeTestId="connect-change-platform"
          >
            Run on{" "}
            <span className="inline-flex items-center gap-1.5 align-middle font-medium text-foreground">
              <OsLogos platform={platform} />
              {platformLabels[platform]}
            </span>
          </SetupSummaryRow>
        </ul>
      </WizardStep>

      <WizardStep n={3} title="Run the setup script" last={!showOAuthStep}>
        <div className="flex flex-col gap-3">
          <output
            className="sr-only"
            aria-live="polite"
            data-testid="connect-command-status"
          >
            {commandStatus}
          </output>
          <CreditWarningNotice warning={result?.creditWarning} />
          <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
            {providers.length > 1 && proxyActive && (
              <div className="flex items-center gap-1 border-b border-[#1f2937] px-3">
                {providers.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleProviderSelect(p)}
                    className={cn(
                      "border-b-2 px-2.5 py-2.5 font-mono text-xs transition-colors",
                      p === provider
                        ? "border-white font-semibold text-white"
                        : "border-transparent text-[#9ca3af] hover:text-white",
                    )}
                  >
                    {providerCatalog.label(p)}
                  </button>
                ))}
              </div>
            )}
            {!hasRunnableAnything ? (
              <div className="px-5 py-4 text-sm text-[#9ca3af]">
                No selected resource can be configured for this client and
                operating system. Choose another platform or add a connection
                resource.
              </div>
            ) : needsPerUserConnect && provider ? (
              <PerUserConnectGate
                providerLabel={providerCatalog.label(provider)}
                pending={createPerUserKey.isPending}
                onToken={async (token) => {
                  try {
                    await createPerUserKey.mutateAsync({
                      name: providerCatalog.label(provider),
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
            ) : virtualKeyUnbacked ? (
              <ProviderKeyGate
                reason={noVirtualKeyReason}
                provider={soleProvider}
                addKeyPhrase={addKeyPhrase}
                canAddKey={canCreateProviderKey === true}
                onAddKey={() => setShowAddProviderKey(true)}
              />
            ) : (
              <SetupCommandLine
                command={result?.command ?? null}
                pending={isPending || (!result && !failed)}
                failed={failed}
                onRetry={() => runGeneration(inputsKey)}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="max-w-2xl">
              The command downloads a one-time setup script (expires in 15
              minutes) and pipes it straight to{" "}
              {platform === "windows" ? "PowerShell" : "Bash"} on{" "}
              {platformLabels[platform]}. The script applies the setup reviewed
              above by editing your client config in place — it isn&apos;t
              undone automatically, so revert manually if you need to.
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

      {showOAuthStep && (
        <WizardStep n={4} title={FINISH_OAUTH_FLOW_TITLE} last>
          <div className="flex flex-col gap-3 text-sm text-muted-foreground">
            <p>
              The script only registers the gateway — the gateway grants tool
              access per user, so its tools stay unavailable until you sign in
              once and approve it for your account.
            </p>
            <ol className="list-decimal space-y-3 pl-5">
              <li className="space-y-2">
                <p>Open the MCP manager in Claude Code:</p>
                <TerminalBlock code="claude /mcp" />
              </li>
              <li>
                Select{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                  {oauthServerName}
                </code>{" "}
                and start authentication. Claude Code opens your browser — sign
                in and approve the gateway.
              </li>
            </ol>
          </div>
        </WizardStep>
      )}

      <CreateLlmProviderApiKeyDialog
        open={showAddProviderKey}
        onOpenChange={setShowAddProviderKey}
        title={`Add ${addKeyPhrase}`}
        description={providerKeyDialogDescription}
        defaultValues={
          supportedProviders[0]
            ? { provider: supportedProviders[0] }
            : undefined
        }
        allowedProviders={supportedProviders}
        onSuccess={() => setShowAddProviderKey(false)}
      />
    </>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

function BundlePicker({
  bundles,
  activeBundleId,
  mcpGateways,
  onSelect,
  selectedOptionalLocalMcpServerIds,
  onToggleOptionalLocalMcpServer,
}: {
  bundles: ResolvedBundle[];
  activeBundleId: string | null;
  mcpGateways: AgentSelectorAgent[] | null;
  onSelect: (bundle: ResolvedBundle) => void;
  selectedOptionalLocalMcpServerIds: string[];
  onToggleOptionalLocalMcpServer: (serverId: string, checked: boolean) => void;
}) {
  const activeBundle =
    bundles.find((bundle) => bundle.id === activeBundleId) ?? null;
  return (
    <fieldset className="rounded-xl border border-border/70 bg-muted/20 p-3.5">
      <legend className="flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
        <span>Start with a bundle</span>
        <Badge variant="secondary">Beta</Badge>
        <Link
          href="/bundles"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Manage
        </Link>
      </legend>
      <p className="mb-3 text-xs text-muted-foreground">
        Apply a curated starting point, then review it below. Skills install
        together as one generated plugin; native plugins remain separately
        managed. A bundle can also select its saved MCP gateway.
      </p>
      <ScrollArea className="max-h-72" aria-label="Available bundles">
        <div className="grid gap-2 pr-3 sm:grid-cols-2">
          {bundles.map((bundle) => {
            const active = activeBundleId === bundle.id;
            const empty =
              bundle.skillIds.length === 0 &&
              bundle.pluginIds.length === 0 &&
              bundle.localMcpServers.length === 0;
            const gatewayName = bundle.mcpGatewayId
              ? (mcpGateways?.find(
                  (gateway) => gateway.id === bundle.mcpGatewayId,
                )?.name ?? "Saved MCP gateway")
              : null;
            return (
              <Button
                key={bundle.id}
                type="button"
                variant="outline"
                aria-label={`Apply ${bundle.name} bundle${empty ? ": unavailable because it has no capabilities" : ""}`}
                aria-pressed={active}
                disabled={empty}
                title={
                  empty
                    ? "This bundle has no capabilities to apply. Edit it to add skills, plugins, or local MCP servers."
                    : undefined
                }
                onClick={() => onSelect(bundle)}
                className={cn(
                  "h-auto min-h-28 w-full items-start justify-start gap-3 whitespace-normal rounded-lg p-3.5 text-left hover:border-foreground/30 hover:bg-background",
                  active &&
                    "border-foreground/40 bg-background ring-1 ring-foreground/10",
                )}
              >
                <span className="mt-0.5 rounded-md border border-border bg-muted p-2 text-foreground">
                  <PackageOpen className="size-4" />
                </span>
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="flex items-center justify-between gap-2 font-medium text-foreground">
                    <span>{bundle.name}</span>
                    {active ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="size-3" />
                        <span>Selected</span>
                      </Badge>
                    ) : null}
                  </span>
                  {bundle.description ? (
                    <span className="text-xs leading-relaxed text-muted-foreground">
                      {bundle.description}
                    </span>
                  ) : null}
                  <span className="mt-1 text-[11px] font-medium text-muted-foreground">
                    {formatBundleCapabilitySummary({
                      skillCount: bundle.skillIds.length,
                      pluginCount: bundle.pluginIds.length,
                      localMcpCount: bundle.localMcpServers.length,
                    })}
                  </span>
                  {gatewayName ? (
                    <span className="text-[11px] text-muted-foreground">
                      Gateway: {gatewayName}
                    </span>
                  ) : null}
                  {empty ? (
                    <span className="text-[11px] text-muted-foreground">
                      Add capabilities before this bundle can be applied.
                    </span>
                  ) : null}
                </span>
              </Button>
            );
          })}
        </div>
      </ScrollArea>
      {activeBundle && activeBundle.localMcpServers.length > 0 ? (
        <div className="mt-3 grid gap-2 border-t pt-3">
          <p className="text-xs font-medium text-foreground">
            Local MCP servers for Cursor and Claude Code
          </p>
          {activeBundle.localMcpServers.map((server) => {
            const checked =
              !server.optional ||
              selectedOptionalLocalMcpServerIds.includes(server.id);
            return (
              <div
                key={server.id}
                className="flex items-start gap-2 rounded-md border bg-background px-3 py-2"
              >
                <Checkbox
                  id={`bundle-local-mcp-${server.id}`}
                  checked={checked}
                  disabled={!server.optional}
                  onCheckedChange={(value) =>
                    onToggleOptionalLocalMcpServer(server.id, value === true)
                  }
                />
                <Label
                  htmlFor={`bundle-local-mcp-${server.id}`}
                  className="grid min-w-0 gap-0.5 text-xs"
                >
                  <span className="font-medium text-foreground">
                    {server.name}
                    {!server.optional ? <span> (required)</span> : null}
                  </span>
                  {server.description ? (
                    <span className="text-muted-foreground">
                      {server.description}
                    </span>
                  ) : null}
                </Label>
              </div>
            );
          })}
        </div>
      ) : null}
    </fieldset>
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
 * Step-3 gate for the virtual-key path when no provider key can back it. Mirrors
 * the per-user connect gate: instead of emitting a script that silently drops
 * the inference proxy, it names the blocker and offers the fix inline — add a
 * provider key, or switch the proxy to your provider key up in the review step.
 */
function ProviderKeyGate({
  reason,
  provider,
  addKeyPhrase,
  canAddKey,
  onAddKey,
}: {
  reason: string;
  /** The lone provider to brand the CTA with, or null when several are routed. */
  provider: SupportedProvider | null;
  /** e.g. "an OpenAI key" / "a provider key" — used in both the copy and button. */
  addKeyPhrase: string;
  canAddKey: boolean;
  onAddKey: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="text-[13px] text-[#e5e7eb]">
        <span>{reason} </span>
        {canAddKey ? (
          <span>{`Add ${addKeyPhrase} to mint one from, or switch to your provider key in the review above.`}</span>
        ) : (
          <span>{`Ask an admin to add ${addKeyPhrase}, or switch to your provider key in the review above.`}</span>
        )}
      </p>
      {canAddKey && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onAddKey}
            data-testid="connect-gate-add-provider-key"
          >
            {provider ? (
              <ProviderIcon provider={provider} size={16} />
            ) : (
              <KeyRound className="size-4" />
            )}
            <span>Add {addKeyPhrase}</span>
          </Button>
        </div>
      )}
    </div>
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

const SKILL_NAME_PREVIEW_LIMIT = 6;

/** Names the skills the command will install, truncated past the limit. */
function SkillNamesLine({ skills }: { skills: ConnectSkill[] }) {
  const shown = skills.slice(0, SKILL_NAME_PREVIEW_LIMIT);
  const more = skills.length - shown.length;
  return (
    <p className="text-xs text-muted-foreground/80">
      {shown.map((s) => s.name).join(", ")}
      {more > 0 ? ` and ${more} more` : ""}
    </p>
  );
}

function PluginsDetail({
  plugins,
  incompatiblePlugins,
  clientId,
  platform,
}: {
  plugins: PluginListItem[];
  incompatiblePlugins: PluginListItem[];
  clientId: ScriptClientId;
  platform: ConnectPlatformOption;
}) {
  const shown = plugins.slice(0, SKILL_NAME_PREVIEW_LIMIT);
  const more = plugins.length - shown.length;
  return (
    <div className="grid gap-1 text-xs text-muted-foreground/80">
      {plugins.length > 0 && (
        <>
          <p>
            {shown.map((plugin) => plugin.displayName).join(", ")}
            {more > 0 ? ` and ${more} more` : ""}
          </p>
          {clientId === "codex" && (
            <p>After setup, open /hooks and approve each content hash.</p>
          )}
        </>
      )}
      {incompatiblePlugins.length > 0 && (
        <p>
          Not compatible with {platformLabels[platform]}:{" "}
          {incompatiblePlugins.map((plugin) => plugin.displayName).join(", ")}.
        </p>
      )}
    </div>
  );
}

/** Join names as a readable list: "A", "A and B", "A, B, and C". */
function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "a" or "an" for `word`, by its leading letter (good enough for brand names). */
function indefiniteArticle(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Label stacked above its control inside an inline editor. */
function EditorField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
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
      <SelectTrigger aria-label="Select an endpoint" className="w-full">
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
      or set up the{" "}
      <Link href="/llm/proxy" className="underline hover:text-foreground">
        LLM Proxy
      </Link>{" "}
      first.
    </div>
  );
}
