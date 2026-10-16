"use client";

import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
  getChatModelOptionTestId,
  modelSupportsThinkingEffort,
  type SupportedProvider,
  type ThinkingEffortSetting,
} from "@archestra/shared";
import { Command as CommandPrimitive, defaultFilter } from "cmdk";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  AudioLinesIcon,
  BoxIcon,
  BrainIcon,
  EyeIcon,
  FileTextIcon,
  KeyRoundIcon,
  LogInIcon,
  type LucideIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  UsersRoundIcon,
  VideoIcon,
  WrenchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentIcon } from "@/components/agent-icon";
import { agentListHref } from "@/components/agent-pages/agent-page-config";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";
import {
  type ChatSetupAgent,
  REASONING_OPTIONS,
  useChatSetupOptions,
} from "@/lib/chat/use-chat-setup-options";
import type { LlmModel } from "@/lib/llm-models.query";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { formatPricePerMillion } from "@/lib/model-price-format";
import { logoNameForProvider } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";

type Scope = "model" | "agent" | "key";

export interface ChatSetupMenuProps {
  conversationId?: string;
  /** Close the menu and hand focus back to the prompt. */
  close: () => void;
  agentId: string | null | undefined;
  /** Omitted when the viewer may not switch agents. */
  onAgentChange?: (agentId: string) => void;
  /** Model, key, and reasoning are hidden without chat:full-view. */
  canShowProviderSettings: boolean;
  selectedModel: string;
  onModelChange: (dbId: string) => void;
  fallbackModelName?: string;
  modelSource?: ModelSource | null;
  onResetModelOverride?: () => void;
  suppressAutoSelect: boolean;
  apiKeyId: string | null;
  currentProvider?: SupportedProvider;
  canChangeCredential: boolean;
  onApiKeyChange?: (apiKeyId: string) => void;
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  subscriptionConnectRequired: boolean;
  onSubscriptionConnect?: () => void;
  subscriptionSignInTitle: string;
  thinkingEffort: ThinkingEffortSetting;
  onThinkingEffortChange?: (effort: ThinkingEffortSetting) => void;
  toolsUnavailable: boolean;
  notRecommendedForAgents: boolean;
}

/**
 * The composer's setup menu: search on top, then one tab per setting that
 * shows its current value (model, agent, key). The list below holds the
 * active tab's choices, so every change is one surface and one click.
 * Picking a model or agent closes the menu; picking a key keeps it open on
 * the model tab, since the key decides which models exist.
 */
export function ChatSetupMenu(ctx: ChatSetupMenuProps) {
  const [query, setQuery] = useState("");
  const [scopeState, setScopeState] = useState<Scope>("model");
  const data = useChatSetupOptions({
    ...ctx,
    agentSearch: scopeState === "agent" ? query : "",
  });
  const router = useRouter();
  const [active, setActive] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);
  const searching = query.trim().length > 0;

  // ---- gates
  const showProvider = ctx.canShowProviderSettings;
  const showModels = showProvider && !ctx.subscriptionConnectRequired;
  const showSignIn =
    showProvider &&
    ctx.subscriptionConnectRequired &&
    !!ctx.onSubscriptionConnect;
  const showReset =
    showModels && ctx.modelSource === "user" && !!ctx.onResetModelOverride;
  const showReasoning = showModels && data.supportsReasoning;

  const allModels = useMemo(
    () => data.modelSections.flatMap((s) => s.models),
    [data.modelSections],
  );
  const allAgents = useMemo(
    () => data.agentGroups.flatMap((g) => g.agents),
    [data.agentGroups],
  );
  const currentModel = data.activeModel;
  const currentAgent = data.activeAgent;
  const currentKey = data.activeKey;
  const modelProvider = currentModel?.provider ?? ctx.currentProvider;

  // ---- scopes on offer, in tab order
  const scopes = useMemo(() => {
    // Broadest choice first: the agent, then the key that decides which
    // models exist, then the model. The menu still opens on Model.
    const list: Scope[] = [];
    if (ctx.onAgentChange && allAgents.length > 0) list.push("agent");
    if (showProvider && ctx.canChangeCredential && data.keys.length > 0)
      list.push("key");
    if (showModels || showSignIn) list.push("model");
    return list;
  }, [
    showModels,
    showSignIn,
    ctx.onAgentChange,
    allAgents.length,
    showProvider,
    ctx.canChangeCredential,
    data.keys.length,
  ]);
  const scope: Scope | undefined = scopes.includes(scopeState)
    ? scopeState
    : scopes[0];

  // ---- what each tab shows: the live value, not the kind
  const tabs: Record<Scope, { icon: ReactNode; text: string; aria: string }> = {
    model: showSignIn
      ? {
          icon: <LogInIcon className="size-4" />,
          text: "Sign in",
          aria: `Model: ${ctx.subscriptionSignInTitle}`,
        }
      : {
          icon: modelProvider ? (
            <ModelSelectorLogo
              provider={logoNameForProvider(modelProvider)}
              className="size-4"
            />
          ) : (
            <BoxIcon className="size-4" />
          ),
          text: data.modelName,
          aria: `Model: ${data.modelName}`,
        },
    agent: {
      icon: <AgentIcon icon={data.agentIcon} size={16} />,
      text: data.agentName,
      aria: `Agent: ${data.agentName}`,
    },
    key: {
      icon: <KeyRoundIcon className="size-4" />,
      text: currentKey?.name ?? "Default key",
      aria: currentKey
        ? `Key: ${currentKey.name} (${data.keyScopeLabel(currentKey)})`
        : "Key: Default key",
    },
  };

  // ---- match counts per scope (drives the "N matches in Agents" row)
  const matchCounts = useMemo(() => {
    const count = (keywordSets: string[][]) =>
      searching
        ? keywordSets.filter((kw) => score(kw, query) > 0).length
        : keywordSets.length;
    return {
      model: count(
        showSignIn
          ? [signInKeywords(ctx.subscriptionSignInTitle)]
          : showModels
            ? allModels.map((m) => modelKeywords(m, data.providerLabel))
            : [],
      ),
      agent: count(allAgents.map(agentKeywords)),
      key: count(
        data.keys.map((k) =>
          keyKeywords(k, data.providerLabel, data.keyScopeLabel),
        ),
      ),
    } satisfies Record<Scope, number>;
  }, [
    searching,
    query,
    showSignIn,
    showModels,
    ctx.subscriptionSignInTitle,
    allModels,
    allAgents,
    data.keys,
    data.providerLabel,
    data.keyScopeLabel,
  ]);
  const elsewhere =
    searching && scope && matchCounts[scope] === 0
      ? scopes
          .filter((s) => s !== scope && matchCounts[s] > 0)
          .sort((a, b) => matchCounts[b] - matchCounts[a])[0]
      : undefined;

  // ---- on open / scope swap / model refetch: highlight the current item and
  // center it; while searching, fall back to the first visible match.
  const currentValue =
    scope === "model"
      ? currentModel
        ? modelValue(currentModel.dbId)
        : ""
      : scope === "agent"
        ? currentAgent
          ? agentValue(currentAgent.id)
          : ""
        : currentKey
          ? keyValue(currentKey.id)
          : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the rendered rows change, not on every keystroke
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const current =
        currentValue && !searching
          ? list.querySelector(
              `[cmdk-item=""][data-value="${CSS.escape(currentValue)}"]`,
            )
          : null;
      const target =
        current ??
        list.querySelector('[cmdk-item=""]:not([aria-disabled="true"])');
      setActive(target?.getAttribute("data-value") ?? "");
      if (current) centerIn(list, current);
      else list.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [scope, data.modelSections, currentValue]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // ---- actions
  const switchScope = (next: Scope) => {
    setScopeState(next);
    inputRef.current?.focus({ preventScroll: true });
  };
  const cycleScope = (delta: 1 | -1) => {
    if (!scope || scopes.length < 2) return;
    const i = scopes.indexOf(scope);
    switchScope(scopes[(i + delta + scopes.length) % scopes.length]);
  };
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Tab" && scopes.length > 1) {
      e.preventDefault();
      cycleScope(e.shiftKey ? -1 : 1);
      return;
    }
    // → at the end of the query hops into the reasoning control.
    const input = e.currentTarget;
    if (
      e.key === "ArrowRight" &&
      showReasoning &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length
    ) {
      const radio = reasoningRef.current?.querySelector<HTMLElement>(
        '[aria-checked="true"]',
      );
      if (radio) {
        e.preventDefault();
        radio.focus();
      }
    }
  };
  const pickModel = (m: LlmModel) => {
    data.selectModel(m.dbId);
    ctx.close();
  };
  const pickAgent = (id: string) => {
    data.selectAgent(id);
    ctx.close();
  };
  const pickKey = (k: LlmProviderApiKey) => {
    data.selectKey(k);
    setQuery("");
    switchScope("model");
  };

  const warning = ctx.toolsUnavailable
    ? "This model can't use the agent's tools"
    : ctx.notRecommendedForAgents
      ? "Small model — tool use may be unreliable"
      : null;
  const placeholder = scope ? PLACEHOLDER[scope] : "Search…";

  if (!scope) {
    return (
      <div className="flex h-10 w-[350px] max-w-[calc(100vw-2rem)] items-center px-3 text-xs text-muted-foreground">
        Nothing to change in this chat
      </div>
    );
  }

  return (
    <Command
      data-testid={E2eTestId.ChatSetupMenu}
      label="Chat options"
      loop
      value={active}
      onValueChange={setActive}
      filter={(value, search, keywords) =>
        defaultFilter(keywords?.length ? keywords.join(" ") : value, search)
      }
      className="w-[350px] max-w-[calc(100vw-2rem)] rounded-none bg-transparent"
    >
      <div className="flex h-10 items-center gap-2.5 border-b pr-2 pl-3">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <CommandPrimitive.Input
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
        />
        {showReasoning && (
          <ReasoningChip
            groupRef={reasoningRef}
            value={ctx.thinkingEffort}
            onChange={(effort) => ctx.onThinkingEffortChange?.(effort)}
            onExit={() => inputRef.current?.focus({ preventScroll: true })}
          />
        )}
      </div>

      {scopes.length > 1 && (
        <div
          role="tablist"
          aria-label="Current setup — choose what to change"
          className="flex h-9 items-stretch border-b px-1"
        >
          {scopes.map((s) => {
            const selected = s === scope;
            const tab = tabs[s];
            return (
              <UnstyledButton
                key={s}
                role="tab"
                aria-selected={selected}
                aria-label={tab.aria}
                title={TAB_LABEL[s]}
                onClick={() => switchScope(s)}
                onKeyDown={keepKeysFromCmdk}
                className={cn(
                  "relative flex min-w-0 basis-0 items-center justify-center gap-1.5 rounded-sm px-2 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                  "after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground after:opacity-0 after:transition-opacity after:duration-150 motion-reduce:after:transition-none",
                  // the model name is usually the longest value — give it a bit more room
                  s === "model" ? "grow-[1.4]" : "grow",
                  selected
                    ? "text-foreground after:opacity-100"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex shrink-0 items-center transition-opacity duration-150 motion-reduce:transition-none",
                    !selected && "opacity-60",
                  )}
                >
                  {tab.icon}
                </span>
                <span className="min-w-0 truncate">{tab.text}</span>
              </UnstyledButton>
            );
          })}
        </div>
      )}

      <CommandList
        ref={listRef}
        label={TAB_LABEL[scope]}
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          if (scope === "agent" && scrollHeight - scrollTop - clientHeight < 48)
            data.loadMoreAgents();
        }}
        className="max-h-[300px] scroll-py-1 p-1"
      >
        {elsewhere ? (
          <CommandItem
            forceMount
            value="action:switch-scope"
            onSelect={() => switchScope(elsewhere)}
            className={cn(ITEM, "text-muted-foreground")}
          >
            <span className="min-w-0 flex-1 truncate">
              {matchCounts[elsewhere]}{" "}
              {matchCounts[elsewhere] === 1 ? "match" : "matches"} in{" "}
              {PLURAL[elsewhere]}
            </span>
            <ArrowRightIcon />
          </CommandItem>
        ) : (
          <CommandEmpty className="truncate px-3 py-6 text-center text-xs text-muted-foreground">
            {searching
              ? `No ${PLURAL[scope].toLowerCase()} match “${query.trim()}”`
              : `No ${PLURAL[scope].toLowerCase()} available`}
          </CommandEmpty>
        )}

        {/* ---------------- Model scope ---------------- */}
        {scope === "model" && showSignIn && (
          <CommandGroup className={GROUP}>
            <CommandItem
              value="action:subscription-connect"
              keywords={signInKeywords(ctx.subscriptionSignInTitle)}
              onSelect={() => ctx.onSubscriptionConnect?.()}
              className={cn(
                ITEM,
                "font-medium text-primary data-[selected=true]:bg-primary/15 data-[selected=true]:text-primary",
              )}
            >
              <LogInIcon className="text-primary" />
              <span className="min-w-0 flex-1 truncate">
                {ctx.subscriptionSignInTitle}
              </span>
              <span className="shrink-0 text-xs text-primary/70">
                Required to choose a model
              </span>
            </CommandItem>
          </CommandGroup>
        )}

        {scope === "model" && showModels && (
          <>
            {data.modelsLoading && allModels.length === 0 && (
              <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
                Loading models…
              </div>
            )}
            {showReset && (
              <CommandGroup className={GROUP}>
                <CommandItem
                  value="action:reset-model"
                  keywords={["reset", "default"]}
                  onSelect={() => {
                    ctx.onResetModelOverride?.();
                    ctx.close();
                  }}
                  className={cn(ITEM, "text-muted-foreground")}
                >
                  <RotateCcwIcon />
                  <span className="min-w-0 flex-1 truncate">
                    Reset to default model
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {data.modelSections.map((s) => (
              <CommandGroup
                key={s.provider}
                // One provider is implied by the key; name providers only
                // when the list mixes them.
                heading={data.modelSections.length > 1 ? s.label : undefined}
                className={GROUP}
              >
                {s.models.map((m) => {
                  const isCurrent = m.dbId === currentModel?.dbId;
                  return (
                    <ModelEntry
                      key={m.dbId}
                      model={m}
                      keywords={modelKeywords(m, data.providerLabel)}
                      selected={isCurrent}
                      warning={isCurrent && !searching ? warning : null}
                      onSelect={() => pickModel(m)}
                    />
                  );
                })}
              </CommandGroup>
            ))}
          </>
        )}

        {/* ---------------- Agent scope ---------------- */}
        {scope === "agent" &&
          data.agentGroups.map((g) => (
            <CommandGroup key={g.label} heading={g.label} className={GROUP}>
              {g.agents.map((a) => {
                const isCurrent = a.id === currentAgent?.id;
                const gate = data.agentGate(a.id);
                return (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    meta={
                      gate.kind === "ok"
                        ? isCurrent
                          ? data.agentToolsSummary
                          : null
                        : `Needs ${gate.serverNames.join(", ")}`
                    }
                    disabled={gate.kind === "block" && !isCurrent}
                    selected={isCurrent}
                    onSelect={() => pickAgent(a.id)}
                  />
                );
              })}
            </CommandGroup>
          ))}
        {scope === "agent" && (
          <ExitRow
            value="action:all-agents"
            icon={<UsersRoundIcon />}
            label="All agents"
            onSelect={() => {
              ctx.close();
              router.push(agentListHref("agent"));
            }}
          />
        )}

        {/* ---------------- Key scope ---------------- */}
        {scope === "key" &&
          data.keySections.map((s) => (
            <CommandGroup
              key={s.provider}
              heading={s.label}
              className={GROUP}
              data-testid={getChatApiKeySelectorProviderGroupTestId(s.provider)}
            >
              {s.keys.map((k) => (
                <KeyRow
                  key={k.id}
                  apiKey={k}
                  keywords={keyKeywords(
                    k,
                    data.providerLabel,
                    data.keyScopeLabel,
                  )}
                  scopeLabel={data.keyScopeLabel(k)}
                  selected={k.id === currentKey?.id}
                  onSelect={() => pickKey(k)}
                />
              ))}
            </CommandGroup>
          ))}
        {scope === "key" && (
          <ExitRow
            value="action:manage-keys"
            icon={<SettingsIcon />}
            label="Manage provider keys"
            onSelect={() => {
              ctx.close();
              router.push("/llm/model-providers");
            }}
          />
        )}
      </CommandList>
    </Command>
  );
}

// ============================================================================
// Rows
// ============================================================================

const TAB_LABEL: Record<Scope, string> = {
  model: "Model",
  agent: "Agent",
  key: "Key",
};
const PLURAL: Record<Scope, string> = {
  model: "Models",
  agent: "Agents",
  key: "Keys",
};
const PLACEHOLDER: Record<Scope, string> = {
  model: "Search models…",
  agent: "Search agents…",
  key: "Search keys…",
};

const GROUP =
  "p-0 [&:not(:first-child)]:mt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-muted-foreground";

const ITEM =
  "relative isolate h-8 gap-2 rounded-md px-2 py-0 text-sm transition-colors duration-100 motion-reduce:transition-none";

function ModelRow({
  model,
  keywords,
  selected,
  onSelect,
}: {
  model: LlmModel;
  keywords: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  const needsConnect = !!model.requiresUserConnection && !model.isConnected;
  const capabilities = modelCapabilities(model);
  return (
    <CommandItem
      value={modelValue(model.dbId)}
      data-testid={getChatModelOptionTestId(model.id)}
      keywords={keywords}
      onSelect={onSelect}
      className={cn(ITEM, "h-auto min-h-11 items-start py-1")}
    >
      <Selected on={selected} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-5 min-w-0 items-center gap-2">
          <span
            className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}
          >
            {model.displayName}
          </span>
          {capabilities.length > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70">
              {capabilities.map(({ key, label, Icon }) => (
                <span key={key} role="img" aria-label={label} title={label}>
                  <Icon className="size-3" aria-hidden />
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
          <ModelSpecs model={model} needsConnect={needsConnect} />
        </div>
      </div>
    </CommandItem>
  );
}

/** Context size and price; a model that needs connecting says so instead. */
function ModelSpecs({
  model,
  needsConnect,
}: {
  model: LlmModel;
  needsConnect: boolean;
}) {
  const parts: { key: string; node: ReactNode }[] = [];
  const context = formatContext(model.capabilities?.contextLength);
  if (context) parts.push({ key: "context", node: `${context} context` });
  const price = modelPrice(model);
  if (needsConnect) {
    parts.push({
      key: "connect",
      node: <span className="text-primary/80">Connect</span>,
    });
  } else if (model.isFree) {
    parts.push({ key: "price", node: "Free" });
  } else if (price) {
    parts.push({
      key: "price",
      node: (
        <span
          title={`${price.input} input / ${price.output} output per million tokens`}
        >
          {price.input} / {price.output}
        </span>
      ),
    });
  }
  // Never leave the line blank: fall back to the provider's model id.
  if (parts.length === 0) return <>{model.id}</>;
  return (
    <>
      {parts.map((part, index) => (
        <span key={part.key}>
          {index > 0 && <span className="px-1 opacity-60">·</span>}
          {part.node}
        </span>
      ))}
    </>
  );
}

function ModelEntry({
  warning,
  ...row
}: Parameters<typeof ModelRow>[0] & { warning: string | null }) {
  return (
    <>
      <ModelRow {...row} />
      {warning && (
        <div className="flex h-7 min-w-0 items-center gap-2 px-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className="truncate">{warning}</span>
        </div>
      )}
    </>
  );
}

function AgentRow({
  agent,
  meta,
  disabled,
  selected,
  onSelect,
}: {
  agent: ChatSetupAgent;
  meta: string | null;
  disabled: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={agentValue(agent.id)}
      keywords={agentKeywords(agent)}
      disabled={disabled}
      onSelect={onSelect}
      className={ITEM}
    >
      <AgentIcon icon={agent.icon} size={16} className="shrink-0" />
      <span
        className={cn("min-w-0 flex-1 truncate", selected && "font-medium")}
      >
        {agent.name}
      </span>
      <Meta>{meta}</Meta>
      <Selected on={selected} />
    </CommandItem>
  );
}

function KeyRow({
  apiKey,
  keywords,
  scopeLabel,
  selected,
  onSelect,
}: {
  apiKey: LlmProviderApiKey;
  keywords: string[];
  scopeLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={keyValue(apiKey.id)}
      data-testid={getChatApiKeySelectorOptionTestId(apiKey.id)}
      keywords={keywords}
      onSelect={onSelect}
      className={cn(ITEM, "h-auto min-h-11 py-1")}
    >
      <ModelSelectorLogo
        provider={logoNameForProvider(apiKey.provider)}
        className="size-4 shrink-0"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate", selected && "font-medium")}>
          {apiKey.name}
        </span>
        <span className="truncate text-xs leading-4 text-muted-foreground">
          {apiKey.requiresReauthentication ? (
            <span className="text-amber-600 dark:text-amber-400">
              Reconnect
            </span>
          ) : (
            <span>{scopeLabel}</span>
          )}
        </span>
      </div>
      <Selected on={selected} />
    </CommandItem>
  );
}

function ExitRow({
  value,
  icon,
  label,
  onSelect,
}: {
  value: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <CommandGroup className={cn(GROUP, "mt-1 border-t pt-1")}>
      <CommandItem
        value={value}
        keywords={[label]}
        onSelect={onSelect}
        className={cn(ITEM, "text-muted-foreground")}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </CommandItem>
    </CommandGroup>
  );
}

function Meta({ children }: { children: ReactNode }) {
  if (children === null || children === undefined || children === "")
    return null;
  return (
    <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * The current choice: a bar on the row's leading edge, under its content, so
 * trailing icons and labels keep their place.
 */
function Selected({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      role="img"
      aria-label="Current"
      className="absolute inset-y-0 left-0 -z-10 w-[3px] rounded-l-md bg-primary/80"
    />
  );
}

/**
 * Reasoning depth as one outlined chip: a click or tap cycles Auto → Low →
 * Med → High (shift-click goes back), ←/→ step it, Home/End jump to the ends.
 * The word is always visible, so touch needs no hover, and the 3-bar meter
 * reads the level at a glance. A radiogroup holding one focusable radio that
 * is always the checked one keeps the → hand-off from the search input.
 */
function ReasoningChip({
  groupRef,
  value,
  onChange,
  onExit,
}: {
  groupRef: RefObject<HTMLDivElement | null>;
  value: ThinkingEffortSetting;
  onChange: (value: ThinkingEffortSetting) => void;
  /** ↑/↓ hand focus back to the search input (and so to the list). */
  onExit: () => void;
}) {
  const index = Math.max(
    0,
    REASONING_OPTIONS.findIndex((o) => o.value === value),
  );
  const current = REASONING_OPTIONS[index];
  // Direction of the last change, so the new label slides in from the side
  // it "came from" (forward = up from below, backward = down from above).
  // 0 = nothing changed yet, so opening the menu does not animate.
  const [dir, setDir] = useState<0 | 1 | -1>(0);

  const go = (next: number, direction: 1 | -1) => {
    const n = REASONING_OPTIONS.length;
    setDir(direction);
    onChange(REASONING_OPTIONS[(next + n) % n].value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const handled = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown":
        return handled(onExit);
      case "ArrowRight":
        return handled(() => go(index + 1, 1));
      case "ArrowLeft":
        return handled(() => go(index - 1, -1));
      case "Home":
        return handled(() => go(0, -1));
      case "End":
        return handled(() => go(REASONING_OPTIONS.length - 1, 1));
      case "Enter":
      case " ":
        // Let the button's own click fire (it cycles), but keep cmdk from
        // treating the key as "select the highlighted list row".
        e.stopPropagation();
    }
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="Reasoning effort"
      onKeyDown={onKeyDown}
      className="inline-flex shrink-0"
    >
      <UnstyledButton
        role="radio"
        aria-checked="true"
        tabIndex={0}
        aria-label={`Reasoning: ${current.label}`}
        aria-description="Click or use the left and right arrow keys to change"
        title={`Reasoning: ${current.label} — ${current.hint}. Click to change (shift-click goes back).`}
        onClick={(e) => (e.shiftKey ? go(index - 1, -1) : go(index + 1, 1))}
        className={cn(
          "group inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs outline-none",
          "transition-colors duration-150 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring active:bg-muted motion-reduce:transition-none",
          "select-none touch-manipulation",
        )}
      >
        <BrainIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-colors duration-150 motion-reduce:transition-none",
            current.value === null
              ? "text-muted-foreground/70"
              : "text-foreground/80",
          )}
        />
        {/* All labels share one grid cell so the chip keeps the width of the
            widest word and never jitters as it cycles. */}
        <span aria-hidden className="grid overflow-hidden text-left">
          {REASONING_OPTIONS.map((o) => (
            <span key={o.label} className="invisible col-start-1 row-start-1">
              {o.label}
            </span>
          ))}
          <span
            key={`${current.label}:${dir}`}
            className={cn(
              "col-start-1 row-start-1 text-foreground",
              dir !== 0 &&
                "fade-in animate-in duration-150 ease-out motion-reduce:animate-none",
              dir === 1 && "slide-in-from-bottom-2",
              dir === -1 && "slide-in-from-top-2",
            )}
          >
            {current.label}
          </span>
        </span>
        {/* Micro meter: Auto fills none, High fills all three. */}
        <span aria-hidden className="inline-flex shrink-0 items-end gap-px">
          {[1, 2, 3].map((bar) => (
            <span
              key={bar}
              className={cn(
                "h-2 w-[3px] rounded-full transition-colors duration-150 motion-reduce:transition-none",
                bar <= index ? "bg-foreground/70" : "bg-muted-foreground/30",
              )}
            />
          ))}
        </span>
      </UnstyledButton>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * cmdk handles Enter/arrows on its root and preventDefaults Enter to run the
 * highlighted item, which would swallow activation of real buttons inside the
 * palette (scope tabs, reasoning). Keep those keys local.
 */
function keepKeysFromCmdk(e: KeyboardEvent<HTMLElement>) {
  if (CMDK_KEYS.has(e.key)) e.stopPropagation();
}
const CMDK_KEYS = new Set([
  "Enter",
  " ",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
]);

/** Scroll `el` to the vertical middle of `list` without moving any ancestor. */
function centerIn(list: HTMLElement, el: Element) {
  const l = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  list.scrollTop += r.top - l.top - (l.height - r.height) / 2;
}

function score(keywords: string[], search: string) {
  return defaultFilter(keywords.join(" "), search);
}

function modelKeywords(
  m: LlmModel,
  providerLabel: (p: LlmModel["provider"]) => string,
) {
  return [m.displayName, providerLabel(m.provider), m.id];
}
function agentKeywords(a: ChatSetupAgent) {
  return [a.name];
}
function keyKeywords(
  k: LlmProviderApiKey,
  providerLabel: (p: LlmProviderApiKey["provider"]) => string,
  scopeLabel: (k: LlmProviderApiKey) => string,
) {
  return [k.name, providerLabel(k.provider), scopeLabel(k)];
}
function signInKeywords(title: string) {
  return [title, "sign in", "connect"];
}

function modelValue(dbId: string) {
  return `model:${dbId}`;
}
function agentValue(id: string) {
  return `agent:${id}`;
}
function keyValue(id: string) {
  return `key:${id}`;
}

const MODALITY_CAPABILITIES = [
  ["image", "Reads images", EyeIcon],
  ["pdf", "Reads PDFs", FileTextIcon],
  ["audio", "Hears audio", AudioLinesIcon],
  ["video", "Watches video", VideoIcon],
] as const;

function modelCapabilities(model: LlmModel) {
  const caps = model.capabilities;
  const inputs: string[] = caps?.inputModalities ?? [];
  const list: { key: string; label: string; Icon: LucideIcon }[] = [];
  for (const [key, label, Icon] of MODALITY_CAPABILITIES) {
    if (inputs.includes(key)) list.push({ key, label, Icon });
  }
  if (caps?.supportsToolCalling === true)
    list.push({ key: "tools", label: "Uses tools", Icon: WrenchIcon });
  // The same verdict as the reasoning control, so the icon never promises a
  // depth the menu then refuses to offer.
  if (
    modelSupportsThinkingEffort({
      provider: model.provider,
      modelId: model.id,
      supportsReasoningEffort: caps?.supportsReasoningEffort,
    })
  )
    list.push({
      key: "reasoning",
      label: "Adjustable reasoning",
      Icon: BrainIcon,
    });
  return list;
}

function modelPrice(model: LlmModel) {
  const input = formatPrice(model.capabilities?.pricePerMillionInput);
  const output = formatPrice(model.capabilities?.pricePerMillionOutput);
  return input && output ? { input, output } : null;
}

/** "$10" rather than "$10.00"; sub-dollar precision is kept. */
function formatPrice(price: string | null | undefined) {
  if (price == null || price.trim() === "") return null;
  const formatted = formatPricePerMillion(price);
  if (!Number.isFinite(Number(formatted))) return null;
  return `$${formatted.replace(/\.00$/, "")}`;
}

function formatContext(n: number | null | undefined) {
  if (!n) return null;
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return `${Math.round(n / 1000)}K`;
}
