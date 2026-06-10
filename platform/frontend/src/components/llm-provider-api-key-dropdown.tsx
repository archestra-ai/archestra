"use client";

import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
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
import { useMemo } from "react";
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
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";
import { cn } from "@/lib/utils";

type DropdownLlmProviderApiKey = Pick<
  LlmProviderApiKey,
  "id" | "name" | "provider"
> &
  Partial<Pick<LlmProviderApiKey, "scope" | "teamName">>;

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
  searchPlaceholder = "Search API Keys...",
  emptyTriggerLabel,
  triggerTestId,
  showChatTestIds = false,
  allOptionLabel,
  allOptionSelected = false,
  onSelectAllOption,
  allowOrganizationDefault = false,
  organizationDefaultSelected = false,
  onSelectOrganizationDefault,
}: LlmProviderApiKeyDropdownProps) {
  const keysByProvider = useMemo(
    () => groupKeysByProvider(availableKeys),
    [availableKeys],
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
    (allowOrganizationDefault ? "Organization default" : "Select API key...");

  return (
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
            placeholder={searchPlaceholder}
            data-testid={
              showChatTestIds
                ? E2eTestId.ChatApiKeySelectorSearchInput
                : undefined
            }
          />
          <CommandList onWheelCapture={(event) => event.stopPropagation()}>
            <CommandEmpty>No API keys found.</CommandEmpty>
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
            {availableProviders.map((provider) => (
              <CommandGroup
                key={provider}
                data-testid={
                  showChatTestIds
                    ? getChatApiKeySelectorProviderGroupTestId(provider)
                    : undefined
                }
                heading={<ProviderGroupHeading provider={provider} />}
              >
                {keysByProvider[provider]?.map((key) => (
                  <CommandItem
                    key={key.id}
                    data-testid={
                      showChatTestIds
                        ? getChatApiKeySelectorOptionTestId(key.id)
                        : undefined
                    }
                    value={`${provider} ${key.name} ${key.teamName || ""}`}
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
