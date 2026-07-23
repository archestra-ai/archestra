"use client";

import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
  getSubscriptionPickerOptionTestId,
  providerDisplayNames,
  type ResourceVisibilityScope,
  type SupportedProvider,
} from "@archestra/shared";
import {
  Building2,
  CheckIcon,
  ChevronDown,
  Key,
  User,
  Users,
} from "lucide-react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { UseSubscriptionDialog } from "@/components/use-subscription-dialog";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { type SubscriptionEntry, useSubscriptions } from "@/lib/subscriptions";
import { cn } from "@/lib/utils";

type DropdownLlmProviderApiKey = Pick<
  LlmProviderApiKey,
  "id" | "name" | "provider"
> &
  Partial<
    Pick<
      LlmProviderApiKey,
      "scope" | "teamName" | "userId" | "isChatgptSubscription"
    >
  >;

interface LlmProviderApiKeyDropdownProps {
  availableKeys: DropdownLlmProviderApiKey[];
  selectedApiKeyId: string | null;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectKey: (keyId: string) => void;
  currentProvider?: SupportedProvider;
  triggerVariant?: "prompt-input" | "button" | "select";
  triggerClassName?: string;
  popoverClassName?: string;
  popoverPortal?: boolean;
  searchPlaceholder?: string;
  emptyTriggerLabel?: string;
  triggerTestId?: string;
  showChatTestIds?: boolean;
  allOptionLabel?: string;
  allOptionSelected?: boolean;
  onSelectAllOption?: () => void;
  allowOrganizationDefault?: boolean;
  organizationDefaultSelected?: boolean;
  onSelectOrganizationDefault?: () => void;
  /**
   * Lift the three subscriptions into their own group above the API keys, each
   * with an in-place sign-in when the viewer has no credential of their own.
   * Opt-in: filter-style dropdowns (models list, virtual keys, OAuth clients)
   * pick an existing credential and have nothing to sign into.
   */
  showSubscriptions?: boolean;
}

const SCOPE_ICONS: Record<ResourceVisibilityScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org: <Building2 className="h-3 w-3" />,
};

export function LlmProviderApiKeyDropdown({
  availableKeys,
  selectedApiKeyId,
  disabled = false,
  open,
  onOpenChange,
  onSelectKey,
  currentProvider,
  triggerVariant = "prompt-input",
  triggerClassName,
  popoverClassName,
  popoverPortal = true,
  searchPlaceholder,
  emptyTriggerLabel,
  triggerTestId,
  showChatTestIds = false,
  allOptionLabel,
  allOptionSelected = false,
  onSelectAllOption,
  allowOrganizationDefault = false,
  organizationDefaultSelected = false,
  onSelectOrganizationDefault,
  showSubscriptions = false,
}: LlmProviderApiKeyDropdownProps) {
  const subscriptions = useSubscriptions(availableKeys);
  const [signInProvider, setSignInProvider] = useState<
    SubscriptionEntry["provider"] | null
  >(null);
  // A key is dropped from the provider groups only when a Subscriptions entry
  // actually represents it, so the same credential never appears twice. A
  // subscription-shaped key that no entry backs — an org/team-scoped
  // ChatGPT-subscription key, or a second personal one — stays listed in its
  // provider group rather than vanishing with nowhere to select it.
  const subscriptionKeyIds = useMemo(
    () =>
      new Set(
        subscriptions
          .map((entry) => entry.apiKeyId)
          .filter((id): id is string => id != null),
      ),
    [subscriptions],
  );
  const apiKeyOnly = useMemo(
    () =>
      showSubscriptions
        ? availableKeys.filter((key) => !subscriptionKeyIds.has(key.id))
        : availableKeys,
    [availableKeys, showSubscriptions, subscriptionKeyIds],
  );
  const keysByProvider = useMemo(
    () => groupKeysByProvider(apiKeyOnly),
    [apiKeyOnly],
  );
  const availableProviders = useMemo(
    () =>
      sortProviders({
        providers: Object.keys(keysByProvider) as SupportedProvider[],
        currentProvider,
      }),
    [keysByProvider, currentProvider],
  );
  const selectedKey = availableKeys.find((key) => key.id === selectedApiKeyId);
  const fallbackTriggerLabel =
    emptyTriggerLabel ??
    (allOptionSelected && allOptionLabel ? allOptionLabel : undefined) ??
    (allowOrganizationDefault
      ? "Organization default"
      : "Select provider key...");
  // With subscriptions in the list, "Search API keys" would misread as the
  // search skipping the Subscriptions group.
  const effectiveSearchPlaceholder =
    searchPlaceholder ??
    (showSubscriptions
      ? "Search subscriptions and API keys..."
      : "Search API keys...");

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          {triggerVariant === "button" || triggerVariant === "select" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              className={cn(
                "h-9 min-w-0 justify-start gap-1.5 px-3 text-sm",
                triggerVariant === "select" && "justify-between",
                triggerClassName,
              )}
              data-testid={triggerTestId}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {selectedKey ? (
                  <>
                    <ProviderIcon provider={selectedKey.provider} />
                    <span className="truncate font-medium">
                      {selectedKey.name}
                    </span>
                  </>
                ) : (
                  <>
                    {triggerVariant === "button" && (
                      <Key className="h-3 w-3 shrink-0" />
                    )}
                    <span className="truncate text-muted-foreground">
                      {fallbackTriggerLabel}
                    </span>
                  </>
                )}
              </span>
              {triggerVariant === "select" && (
                <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              )}
            </Button>
          ) : (
            <PromptInputButton
              disabled={disabled}
              className={cn("max-w-[220px] min-w-0", triggerClassName)}
              data-testid={
                triggerTestId ??
                (showChatTestIds
                  ? E2eTestId.ChatApiKeySelectorTrigger
                  : undefined)
              }
            >
              <Key className="size-4 shrink-0" />
            </PromptInputButton>
          )}
        </PopoverTrigger>
        <PopoverContent
          className={cn("w-80 p-0", popoverClassName)}
          align="start"
          portal={popoverPortal}
        >
          <Command>
            <CommandInput
              placeholder={effectiveSearchPlaceholder}
              data-testid={
                showChatTestIds
                  ? E2eTestId.ChatApiKeySelectorSearchInput
                  : undefined
              }
            />
            <CommandList onWheelCapture={(event) => event.stopPropagation()}>
              <CommandEmpty>
                {showSubscriptions
                  ? "No subscriptions or API keys found."
                  : "No API keys found."}
              </CommandEmpty>
              {allOptionLabel && onSelectAllOption && (
                <CommandGroup>
                  <CommandItem onSelect={onSelectAllOption}>
                    <span className="text-muted-foreground">
                      {allOptionLabel}
                    </span>
                    {allOptionSelected && (
                      <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                    )}
                  </CommandItem>
                </CommandGroup>
              )}
              {allowOrganizationDefault && onSelectOrganizationDefault && (
                <CommandGroup>
                  <CommandItem onSelect={onSelectOrganizationDefault}>
                    <div className="flex min-w-0 flex-col">
                      <span className="text-muted-foreground">
                        Organization default
                      </span>
                      <span className="text-xs text-muted-foreground">
                        No model or key set - falls back to the organization
                        default
                      </span>
                    </div>
                    {organizationDefaultSelected && (
                      <CheckIcon className="ml-auto h-4 w-4 shrink-0" />
                    )}
                  </CommandItem>
                </CommandGroup>
              )}
              {showSubscriptions && (
                <CommandGroup
                  heading={
                    <GroupHeadingWithDescription
                      title="Subscriptions"
                      description="Resolved per user — each person signs in with their own plan"
                    />
                  }
                >
                  {subscriptions.map((entry) => (
                    <SubscriptionItem
                      key={entry.provider}
                      entry={entry}
                      selected={
                        !!entry.apiKeyId && entry.apiKeyId === selectedApiKeyId
                      }
                      onSelect={() => {
                        if (entry.apiKeyId) {
                          onSelectKey(entry.apiKeyId);
                          return;
                        }
                        // Sign-in happens in place; close the popover so the
                        // device-flow dialog isn't trapped under it.
                        onOpenChange(false);
                        setSignInProvider(entry.provider);
                      }}
                    />
                  ))}
                </CommandGroup>
              )}
              {availableProviders.map((provider, index) => (
                <CommandGroup
                  key={provider}
                  data-testid={
                    showChatTestIds
                      ? getChatApiKeySelectorProviderGroupTestId(provider)
                      : undefined
                  }
                  // The "API keys" section label rides in the first provider
                  // group's heading rather than a raw div, so cmdk's search
                  // filtering hides it with the group instead of leaving it
                  // floating over no results.
                  heading={
                    showSubscriptions && index === 0 ? (
                      <span className="flex flex-col gap-2">
                        <GroupHeadingWithDescription
                          title="API keys"
                          description="A stored key — everyone it's shared with uses the same credential"
                        />
                        <ProviderGroupHeading provider={provider} />
                      </span>
                    ) : (
                      <ProviderGroupHeading provider={provider} />
                    )
                  }
                >
                  {keysByProvider[provider]?.map((key) => (
                    <CommandItem
                      key={key.id}
                      data-testid={
                        showChatTestIds
                          ? getChatApiKeySelectorOptionTestId(key.id)
                          : undefined
                      }
                      value={key.id}
                      keywords={[provider, key.name, key.teamName ?? ""]}
                      onSelect={() => onSelectKey(key.id)}
                      className="cursor-pointer"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        {key.scope ? SCOPE_ICONS[key.scope] : null}
                        <span className="truncate">{key.name}</span>
                        {key.scope === "team" && key.teamName ? (
                          <Badge
                            variant="outline"
                            className="px-1 py-0 text-[10px]"
                          >
                            {key.teamName}
                          </Badge>
                        ) : null}
                      </div>
                      {selectedApiKeyId === key.id && (
                        <CheckIcon className="h-4 w-4 shrink-0" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {signInProvider && (
        <UseSubscriptionDialog
          open
          onOpenChange={(next) => {
            if (!next) setSignInProvider(null);
          }}
          providers={[signInProvider]}
          title="Sign in to your subscription"
          description="Connect your own account. Everyone using this model signs in with their own plan."
          onConnected={(apiKeyId) => {
            onSelectKey(apiKeyId);
            setSignInProvider(null);
          }}
        />
      )}
    </>
  );
}

function SubscriptionItem({
  entry,
  selected,
  onSelect,
}: {
  entry: SubscriptionEntry;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      data-testid={getSubscriptionPickerOptionTestId(entry.provider)}
      value={`subscription-${entry.provider}`}
      keywords={[entry.title, "subscription"]}
      disabled={entry.signInUnavailable}
      onSelect={onSelect}
      className="cursor-pointer"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ProviderIcon provider={entry.provider} />
        <span className="truncate">{entry.title}</span>
      </div>
      {entry.signInUnavailable ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          Not enabled
        </span>
      ) : entry.connected ? (
        <>
          <span className="shrink-0 text-xs text-muted-foreground">
            Your account
          </span>
          {selected && <CheckIcon className="h-4 w-4 shrink-0" />}
        </>
      ) : (
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
          Sign in
        </Badge>
      )}
    </CommandItem>
  );
}

/**
 * Two-line group label: the credential type plus, right at the selection
 * point, what picking from this group means (per-user subscription vs shared
 * key) — so the semantics are read while choosing, not from copy elsewhere.
 */
function GroupHeadingWithDescription({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <span className="flex flex-col gap-0.5">
      <span>{title}</span>
      <span className="font-normal">{description}</span>
    </span>
  );
}

function groupKeysByProvider(availableKeys: DropdownLlmProviderApiKey[]) {
  const grouped = {} as Record<SupportedProvider, DropdownLlmProviderApiKey[]>;

  for (const key of availableKeys) {
    if (!grouped[key.provider]) {
      grouped[key.provider] = [];
    }
    grouped[key.provider].push(key);
  }

  return grouped;
}

function ProviderGroupHeading({ provider }: { provider: SupportedProvider }) {
  const providerName = providerDisplayNames[provider] ?? provider;

  return (
    <span className="flex items-center gap-1.5">
      <ProviderIcon provider={provider} />
      <span>{PROVIDER_CONFIG[provider]?.name ?? providerName}</span>
    </span>
  );
}

function ProviderIcon({ provider }: { provider: SupportedProvider }) {
  const providerConfig = PROVIDER_CONFIG[provider];

  if (!providerConfig?.icon) {
    return <Key className="h-3.5 w-3.5 shrink-0" />;
  }

  return (
    <Image
      src={providerConfig.icon}
      alt={providerConfig.name}
      width={14}
      height={14}
      className="shrink-0 rounded dark:invert"
    />
  );
}

function sortProviders(params: {
  providers: SupportedProvider[];
  currentProvider?: SupportedProvider;
}) {
  const { providers, currentProvider } = params;

  return [...providers].sort((a, b) => {
    if (a === currentProvider) return -1;
    if (b === currentProvider) return 1;
    return a.localeCompare(b);
  });
}
