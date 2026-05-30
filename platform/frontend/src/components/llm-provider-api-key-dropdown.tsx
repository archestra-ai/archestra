"use client";

import {
  E2eTestId,
  getChatApiKeySelectorOptionTestId,
  getChatApiKeySelectorProviderGroupTestId,
  providerDisplayNames,
  type ResourceVisibilityScope,
  type SupportedProvider,
} from "@shared";
import { Building2, CheckIcon, Key, User, Users } from "lucide-react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
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

interface LlmProviderApiKeyDropdownProps {
  availableKeys: LlmProviderApiKey[];
  selectedApiKeyId: string | null;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectKey: (keyId: string) => void;
  currentProvider?: SupportedProvider;
  triggerVariant?: "prompt-input" | "button";
  triggerClassName?: string;
  popoverClassName?: string;
  searchPlaceholder?: string;
  showChatTestIds?: boolean;
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
  searchPlaceholder = "Search API Keys...",
  showChatTestIds = false,
  allowOrganizationDefault = false,
  organizationDefaultSelected = false,
  onSelectOrganizationDefault,
}: LlmProviderApiKeyDropdownProps) {
  const keysByProvider = groupKeysByProvider(availableKeys);
  const availableProviders = sortProviders({
    providers: Object.keys(keysByProvider) as SupportedProvider[],
    currentProvider,
  });
  const selectedKey = availableKeys.find((key) => key.id === selectedApiKeyId);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {triggerVariant === "button" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            className={cn(
              "h-8 max-w-[250px] gap-1.5 px-3 text-xs",
              triggerClassName,
            )}
          >
            <Key className="h-3 w-3 shrink-0" />
            {selectedKey ? (
              <>
                <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" />
                <span className="truncate font-medium">{selectedKey.name}</span>
              </>
            ) : (
              <span className="truncate text-muted-foreground">
                Organization default
              </span>
            )}
          </Button>
        ) : (
          <PromptInputButton
            disabled={disabled}
            className={cn("max-w-[220px] min-w-0", triggerClassName)}
            data-testid={
              showChatTestIds ? E2eTestId.ChatApiKeySelectorTrigger : undefined
            }
          >
            <Key className="size-4 shrink-0" />
          </PromptInputButton>
        )}
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-80 p-0", popoverClassName)}
        align="start"
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
          <CommandList>
            <CommandEmpty>No API keys found.</CommandEmpty>
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
                heading={providerDisplayNames[provider] ?? provider}
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
                      {SCOPE_ICONS[key.scope]}
                      <span className="truncate">{key.name}</span>
                      {key.scope === "team" && key.teamName && (
                        <Badge
                          variant="outline"
                          className="px-1 py-0 text-[10px]"
                        >
                          {key.teamName}
                        </Badge>
                      )}
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

function groupKeysByProvider(availableKeys: LlmProviderApiKey[]) {
  const grouped = {} as Record<SupportedProvider, LlmProviderApiKey[]>;

  for (const key of availableKeys) {
    if (!grouped[key.provider]) {
      grouped[key.provider] = [];
    }
    grouped[key.provider].push(key);
  }

  return grouped;
}

function sortProviders(params: {
  providers: SupportedProvider[];
  currentProvider?: SupportedProvider;
}) {
  const { providers, currentProvider } = params;

  return providers.sort((a, b) => {
    if (a === currentProvider) return -1;
    if (b === currentProvider) return 1;
    return a.localeCompare(b);
  });
}
