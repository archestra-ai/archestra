"use client";

import {
  DEFAULT_CLAUDE_CODE_MODEL,
  type SupportedProvider,
} from "@archestra/shared";
import {
  BoxIcon,
  ChevronsUpDownIcon,
  KeyRoundIcon,
  LockIcon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { ChatSetupMenu } from "@/components/chat/chat-setup-menu";
import type { ConnectionKey } from "@/components/claude-connection-pickers.utils";
import {
  companyConnectionIdOf,
  noCompanyConnection,
} from "@/components/claude-connection-pickers.utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useClaudeCodeAccount,
  useClaudeCodeModels,
} from "@/lib/claude-code-account.query";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";
import {
  isOrganizationSubscription,
  organizationSubscriptionName,
} from "@/lib/organization-subscription";
import { logoNameForProvider } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";

/**
 * Which company connection pays for an agent's runs, and which model it
 * runs: two form fields, each opening its own list from the chat composer's
 * menu. Only connections the runtime can call are offered, and the model
 * waits for one.
 */
export function CompanyConnectionPickers({
  keys,
  apiKeyId,
  onApiKeyChange,
  runsOn,
  sharedOnly = false,
  claude = false,
  connectionFixed = false,
  modelId,
  modelName,
  modelProvider,
  onModelChange,
  modelFilter,
  models,
  apiKeyName,
  onAddApiKey,
  disabled = false,
  onApiKeyClear,
  onModelClear,
  lockedConnection,
  modelLocked = false,
  modelLockedReason,
  modelFixed = false,
  compact = false,
  plan = false,
  emptyConnection = plan ? "Choose a plan" : "Choose an API key",
  emptyModel,
}: {
  keys: ConnectionKey[];
  apiKeyId: string | null;
  /**
   * The selected connection's name, for a caller that knows it where the
   * reader's own list does not hold the connection.
   */
  apiKeyName?: string | null;
  onApiKeyChange: (keyId: string) => void;
  /** Whether the agent's runtime can call a provider. */
  runsOn: (provider: SupportedProvider) => boolean;
  /**
   * Only connections shared with a team or the organization are offered:
   * what is picked here runs for others than the reader, so their own
   * personal key cannot be it.
   */
  sharedOnly?: boolean;
  /** A Claude Code agent: the texts name what Claude needs. */
  claude?: boolean;
  /** The connection is decided elsewhere: only its model is picked here. */
  connectionFixed?: boolean;
  modelId: string | null;
  /** The selected model's name, known to the form before the menu loads. */
  modelName: string | null;
  modelProvider: SupportedProvider | null;
  onModelChange: (modelId: string) => void;
  modelFilter?: (model: LlmModel) => boolean;
  /**
   * The models to pick from, in place of the connection's own list: the
   * reader may not be able to list the models of a connection set elsewhere.
   */
  models?: LlmModel[];
  onAddApiKey?: () => void;
  disabled?: boolean;
  /**
   * Takes the connection away again, where it is optional: the field then
   * carries a control that clears it.
   */
  onApiKeyClear?: () => void;
  /** The same for the model. */
  onModelClear?: () => void;
  /**
   * The connection is set elsewhere and is not the reader's to change, such
   * as one an agent's runtime fixes. Shown by this name, since the reader
   * may not be able to read the connection itself, in a locked field that
   * says on hover where it is set (`reason`).
   */
  lockedConnection?: { name: string; reason?: string } | null;
  /** The model is set there too: its field is locked as well. */
  modelLocked?: boolean;
  /** Where the locked model is set, said on hover. */
  modelLockedReason?: string;
  /** The model is decided elsewhere and has no field here. */
  modelFixed?: boolean;
  /**
   * The fields on one line with no visible labels, for a row that already
   * says what they are: a person's own pick on an agent's account card.
   */
  compact?: boolean;
  /**
   * The connections are the GitHub Copilot CLI's enterprise plans, which are
   * no API keys: the texts call them plans.
   */
  plan?: boolean;
  /** What the connection field reads while none is picked. */
  emptyConnection?: string;
  /** The same for the model, with or without a connection. */
  emptyModel?: string;
}) {
  const id = useId();
  const keyFilter = useCallback(
    (key: ConnectionKey) =>
      !isPersonalSubscription(key) &&
      !(sharedOnly && key.scope === "personal") &&
      runsOn(key.provider),
    [runsOn, sharedOnly],
  );
  const copy = claude ? CLAUDE_COPY : RUNTIME_COPY;
  const companyKeys = keys.filter(
    (key) =>
      !isPersonalSubscription(key) && !(sharedOnly && key.scope === "personal"),
  );
  const usable = companyKeys.filter(keyFilter);
  const hiddenCount = companyKeys.length - usable.length;
  const companyKeyId = companyConnectionIdOf(keys, apiKeyId);
  const connection = keys.find((key) => key.id === companyKeyId);

  if (
    !compact &&
    noCompanyConnection({
      keys,
      apiKeyId,
      runsOn,
      sharedOnly,
      connectionFixed,
      lockedConnection,
    })
  ) {
    return (
      <div className="space-y-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{copy.none}</p>
          <p className="max-w-prose text-[13px] leading-normal text-muted-foreground">
            {copy.needs}
          </p>
        </div>
        {onAddApiKey && (
          <Button
            type="button"
            size="sm"
            onClick={onAddApiKey}
            disabled={disabled}
          >
            <span>{copy.add}</span>
          </Button>
        )}
      </div>
    );
  }

  const menu = (scope: "key" | "model", close: () => void) => (
    <ChatSetupMenu
      close={close}
      only={scope}
      agentId={null}
      canShowProviderSettings
      canChangeCredential
      apiKeyId={companyKeyId}
      currentProvider={connection?.provider}
      onApiKeyChange={onApiKeyChange}
      keyFilter={keyFilter}
      keyNote={
        hiddenCount > 0
          ? `${copy.listed} ${hiddenCount} ${hiddenCount === 1 ? "other is" : "others are"} hidden.`
          : undefined
      }
      onAddKey={onAddApiKey}
      selectedModel={modelId ?? ""}
      onModelChange={onModelChange}
      modelFilter={modelFilter}
      models={models}
      // The form picks a connection's model itself, once its catalog is in.
      suppressAutoSelect
      subscriptionConnectRequired={false}
      subscriptionSignInTitle=""
      thinkingEffort={null}
      toolsUnavailable={false}
      notRecommendedForAgents={false}
    />
  );

  return (
    <div className={compact ? COMPACT_ROW : FIELD_GRID}>
      {!connectionFixed && (
        <div
          className={
            compact ? COMPACT_FIELD : "min-w-0 max-w-full space-y-2 sm:max-w-80"
          }
        >
          <Label
            id={`${id}-connection`}
            className={compact ? "sr-only" : undefined}
          >
            {plan ? "Enterprise plan" : "Key"}
          </Label>
          <PickerField
            labelId={`${id}-connection`}
            icon={<KeyRoundIcon />}
            // A locked connection with no name left shows as none.
            value={
              lockedConnection
                ? lockedConnection.name || null
                : ((connection && connectionName(connection)) ??
                  (companyKeyId ? apiKeyName : null) ??
                  null)
            }
            placeholder={emptyConnection}
            disabled={disabled}
            locked={
              lockedConnection
                ? (lockedConnection.reason ??
                  `This ${plan ? "plan" : "connection"} is locked.`)
                : null
            }
            menu={(close) => menu("key", close)}
            // A connection that is set can be cleared, including one that no
            // longer exists and so has no name to show.
            onClear={
              companyKeyId && !lockedConnection ? onApiKeyClear : undefined
            }
            clearLabel={plan ? "Clear plan" : "Clear key"}
          />
        </div>
      )}
      {!modelFixed && (
        <div
          className={
            compact ? COMPACT_FIELD : "min-w-0 max-w-full space-y-2 sm:max-w-80"
          }
        >
          <Label id={`${id}-model`} className={compact ? "sr-only" : undefined}>
            Model
          </Label>
          <PickerField
            labelId={`${id}-model`}
            icon={
              companyKeyId && modelProvider && modelName ? (
                <ModelSelectorLogo
                  provider={logoNameForProvider(modelProvider)}
                  className="size-4"
                />
              ) : (
                <BoxIcon />
              )
            }
            value={companyKeyId ? modelName : null}
            placeholder={
              emptyModel ??
              (companyKeyId
                ? copy.model
                : plan
                  ? "Choose a plan first"
                  : "Choose an API key first")
            }
            disabled={disabled || !companyKeyId}
            locked={
              modelLocked
                ? (modelLockedReason ?? "This model is locked.")
                : null
            }
            menu={(close) => menu("model", close)}
            onClear={
              companyKeyId && modelId && !modelLocked ? onModelClear : undefined
            }
            clearLabel="Clear model"
          />
        </div>
      )}
    </div>
  );
}

/**
 * The model the viewer's runs use on their own Claude subscription: one of
 * the models their Claude account offers, in the composer's model list.
 * Nothing until they are signed in, since the list comes from their account.
 */
export function ClaudeSubscriptionModelPicker({
  agentId,
  model,
  onModelChange,
}: {
  agentId: string;
  /** Their own choice, else the agent's; none means the maintained default. */
  model?: string | null;
  onModelChange: (model: string) => void;
}) {
  const id = useId();
  const account = useClaudeCodeAccount(agentId);
  const connected = account.data?.state === "connected";
  const discovered = useClaudeCodeModels(agentId, connected);
  const models = useMemo<LlmModel[]>(
    () =>
      (discovered.data ?? []).map((entry) => ({
        id: entry.value,
        dbId: entry.value,
        displayName: entry.displayName,
        provider: "anthropic",
        isFree: false,
      })),
    [discovered.data],
  );
  // Without the list there is nothing to pick from; the runs keep their model.
  if (!connected || discovered.isError) return null;
  const selected = model ?? DEFAULT_CLAUDE_CODE_MODEL;
  return (
    <div className="w-52 min-w-0">
      <span id={`${id}-model`} className="sr-only">
        Model
      </span>
      <PickerField
        labelId={`${id}-model`}
        icon={<ModelSelectorLogo provider="anthropic" className="size-4" />}
        value={
          discovered.isPending
            ? null
            : (models.find((entry) => entry.dbId === selected)?.displayName ??
              selected)
        }
        placeholder="Loading models…"
        disabled={discovered.isPending}
        menu={(close) => (
          <ChatSetupMenu
            close={close}
            only="model"
            agentId={null}
            canShowProviderSettings
            canChangeCredential={false}
            apiKeyId={null}
            models={models}
            selectedModel={selected}
            onModelChange={onModelChange}
            suppressAutoSelect
            subscriptionConnectRequired={false}
            subscriptionSignInTitle=""
            thinkingEffort={null}
            toolsUnavailable={false}
            notRecommendedForAgents={false}
          />
        )}
      />
    </div>
  );
}

/**
 * The model the viewer's runs use on a subscription other than Claude's: one
 * of the models their own connection offers that the runtime can run.
 */
export function SubscriptionModelPicker({
  keyId,
  modelId,
  onModelChange,
  modelFilter,
}: {
  /** The viewer's own connection for the subscription. */
  keyId: string;
  /** Their own choice, else the agent's. */
  modelId: string | null;
  onModelChange: (modelId: string) => void;
  modelFilter: (model: LlmModel) => boolean;
}) {
  const id = useId();
  const models = useLlmModels({ apiKeyId: keyId });
  const selected = models.data?.find((model) => model.dbId === modelId);
  return (
    <div className="w-52 min-w-0">
      <span id={`${id}-model`} className="sr-only">
        Model
      </span>
      <PickerField
        labelId={`${id}-model`}
        icon={
          selected ? (
            <ModelSelectorLogo
              provider={logoNameForProvider(selected.provider)}
              className="size-4"
            />
          ) : (
            <BoxIcon />
          )
        }
        value={selected?.displayName ?? null}
        placeholder={models.isPending ? "Loading models…" : "Select a model"}
        disabled={models.isPending}
        menu={(close) => (
          <ChatSetupMenu
            close={close}
            only="model"
            agentId={null}
            canShowProviderSettings
            canChangeCredential={false}
            apiKeyId={keyId}
            selectedModel={modelId ?? ""}
            onModelChange={onModelChange}
            modelFilter={modelFilter}
            suppressAutoSelect
            subscriptionConnectRequired={false}
            subscriptionSignInTitle=""
            thinkingEffort={null}
            toolsUnavailable={false}
            notRecommendedForAgents={false}
          />
        )}
      />
    </div>
  );
}

const CLAUDE_COPY = {
  none: "No API key can run Claude yet",
  needs:
    "Claude Code needs an Anthropic API key, Amazon Bedrock, or Vertex AI with Anthropic models. Add one to use it here.",
  add: "Add an Anthropic key",
  listed: "Only keys that can run Claude are listed.",
  model: "Select a Claude model",
};
const RUNTIME_COPY = {
  none: "No API key can run this agent yet",
  needs:
    "Its runtime needs a key of a provider it can call. Add one to use it here.",
  add: "Add a key",
  listed: "Only keys this runtime can call are listed.",
  model: "Select a model",
};

/**
 * The picked connection as its list names it: an enterprise plan after the
 * GitHub organization it is billed to, any other connection by its name.
 */
function connectionName(connection: ConnectionKey): string {
  return isOrganizationSubscription(connection)
    ? organizationSubscriptionName(connection)
    : connection.name;
}

/**
 * The compact fields: side by side, each as wide as a subscription's. They
 * sit on the right of their card, so fields that wrap keep to that edge.
 */
const COMPACT_ROW = "flex min-w-0 flex-wrap items-center justify-end gap-2";
/** Never wider than the card it is on. */
const COMPACT_FIELD = "w-52 min-w-0 max-w-full";

/** Both cards lay their fields out side by side, sized to their content. */
const FIELD_GRID = "flex flex-wrap items-start gap-3";

/** A form field that shows its value and opens the composer's list to change it. */
function PickerField({
  labelId,
  icon,
  value,
  placeholder,
  disabled,
  menu,
  onClear,
  clearLabel,
  locked = null,
}: {
  labelId: string;
  icon: ReactNode;
  value: string | null;
  placeholder: string;
  disabled: boolean;
  menu: (close: () => void) => ReactNode;
  /** Clears the field's value; the control shows only while this is set. */
  onClear?: () => void;
  clearLabel?: string;
  /**
   * The value is set elsewhere: the field shows it, cannot be opened, and
   * carries a lock in place of its chevron. Where it is set is said on
   * hover and to assistive technology.
   */
  locked?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const valueRef = useRef<HTMLSpanElement>(null);
  const displayText = value ?? placeholder;
  if (locked) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The span takes the pointer while the field is disabled, so
                the reason still shows. */}
            <span className="flex w-full min-w-0">
              <Button
                type="button"
                aria-labelledby={`${labelId} ${labelId}-value`}
                aria-describedby={`${labelId}-locked`}
                variant="outline"
                size="sm"
                disabled
                className="w-full min-w-0 justify-start gap-2 font-normal"
              >
                <span aria-hidden className="flex shrink-0 items-center">
                  {icon}
                </span>
                <span
                  id={`${labelId}-value`}
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !value && "text-muted-foreground",
                  )}
                >
                  {value ?? placeholder}
                </span>
                <LockIcon aria-hidden className="shrink-0" />
                <span id={`${labelId}-locked`} className="sr-only">
                  {locked}
                </span>
              </Button>
            </span>
          </TooltipTrigger>
          {/* The field cannot be opened, so its whole value is here, for
              one too long for the field. */}
          <TooltipContent className="space-y-0.5">
            {value && <p className="font-medium">{value}</p>}
            <p>{locked}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  const handleTooltipOpenChange = (next: boolean) => {
    if (!next || open) {
      setTooltipOpen(false);
      return;
    }
    const el = valueRef.current;
    setTooltipOpen(!!el && el.scrollWidth > el.clientWidth);
  };
  const field = (
    <TooltipProvider>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setTooltipOpen(false);
        }}
      >
        <Tooltip
          open={open ? false : tooltipOpen}
          onOpenChange={handleTooltipOpenChange}
        >
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                // Named by its label and its value, so the value is read out too.
                aria-labelledby={`${labelId} ${labelId}-value`}
                variant="outline"
                size="sm"
                disabled={disabled}
                className={cn(
                  "w-full min-w-0 justify-start gap-2 font-normal",
                  // Room for the clear control, which sits over the field's end.
                  onClear && "pr-8",
                )}
              >
                <span aria-hidden className="flex shrink-0 items-center">
                  {icon}
                </span>
                <span
                  ref={valueRef}
                  id={`${labelId}-value`}
                  className={cn(
                    "min-w-0 flex-1 truncate text-left",
                    !value && "text-muted-foreground",
                  )}
                >
                  {displayText}
                </span>
                {/* The clear control takes the chevron's place while it shows. */}
                {!onClear && (
                  <ChevronsUpDownIcon className="shrink-0 opacity-50" />
                )}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{displayText}</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="w-auto overflow-hidden rounded-xl p-0"
        >
          {menu(() => setOpen(false))}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
  if (!onClear) return field;
  return (
    // The clear control is a button of its own beside the field's, as on the
    // model selector: it takes the keyboard after the field, and a click on
    // it does not open the list.
    <div className="relative">
      {field}
      <UnstyledButton
        type="button"
        aria-label={clearLabel}
        disabled={disabled}
        className="absolute top-1/2 right-2 -translate-y-1/2 shrink-0 rounded-sm opacity-50 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-30"
        onClick={onClear}
      >
        <XIcon className="size-3" />
      </UnstyledButton>
    </div>
  );
}
