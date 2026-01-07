"use client";

import { providerDisplayNames } from "@shared";
import { Building2, CheckIcon, Key, User, Users } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { useUpdateConversation } from "@/lib/chat.query";
import {
  type ChatApiKey,
  type ChatApiKeyScope,
  type SupportedChatProvider,
  useAvailableChatApiKeys,
} from "@/lib/chat-settings.query";

interface ChatApiKeySelectorProps {
  /** Conversation ID for persisting selection (optional for initial chat) */
  conversationId?: string;
  /** Current Conversation Chat API key ID set on the backend */
  currentConversationChatApiKeyId: string | null;
  /** Whether the selector should be disabled */
  disabled?: boolean;
  /** Number of messages in current conversation (for mid-conversation warning) */
  messageCount?: number;
  /** Callback for initial chat mode when no conversationId is available */
  onApiKeyChange?: (apiKeyId: string) => void;
  /** Callback when selected API key's provider differs from current - used to switch model */
  onProviderChange?: (provider: SupportedChatProvider) => void;
  /** Current provider (derived from selected model) - used to detect provider changes */
  currentProvider?: SupportedChatProvider;
}

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

const LOCAL_STORAGE_KEY = "selected-chat-api-key-id";

/**
 * API Key selector for chat - allows users to select which API key to use for the conversation.
 * Shows available keys for the current provider, grouped by scope.
 */
export function ChatApiKeySelector({
  conversationId,
  currentConversationChatApiKeyId,
  disabled = false,
  messageCount = 0,
  onApiKeyChange,
  onProviderChange,
  currentProvider,
}: ChatApiKeySelectorProps) {
  // Fetch ALL available API keys (no provider filter)
  const { data: availableKeys = [], isLoading } = useAvailableChatApiKeys();
  const updateConversationMutation = useUpdateConversation();
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Group keys by provider, then by scope within each provider
  const keysByProviderAndScope = useMemo(() => {
    const grouped: Record<
      SupportedChatProvider,
      Record<ChatApiKeyScope, ChatApiKey[]>
    > = {} as Record<
      SupportedChatProvider,
      Record<ChatApiKeyScope, ChatApiKey[]>
    >;

    for (const key of availableKeys) {
      if (!grouped[key.provider]) {
        grouped[key.provider] = {
          personal: [],
          team: [],
          org_wide: [],
        };
      }
      grouped[key.provider][key.scope].push(key);
    }

    return grouped;
  }, [availableKeys]);

  // Get providers in stable order (alphabetical)
  const orderedProviders = useMemo(() => {
    const providers = Object.keys(
      keysByProviderAndScope,
    ) as SupportedChatProvider[];
    return providers.sort();
  }, [keysByProviderAndScope]);

  // For backward compatibility: get flat list of keys by scope (for auto-select)
  const keysByScope = useMemo(() => {
    const grouped: Record<ChatApiKeyScope, ChatApiKey[]> = {
      personal: [],
      team: [],
      org_wide: [],
    };

    for (const key of availableKeys) {
      grouped[key.scope].push(key);
    }

    return grouped;
  }, [availableKeys]);

  // Find selected key
  const currentConversationChatApiKey = useMemo(() => {
    return availableKeys.find((k) => k.id === currentConversationChatApiKeyId);
  }, [availableKeys, currentConversationChatApiKeyId]);

  // Auto-select first key when no key is selected or current key is invalid
  // biome-ignore lint/correctness/useExhaustiveDependencies: adding updateConversationMutation as a dependency would cause a infinite loop
  useEffect(() => {
    // Skip if loading or no keys available
    if (isLoading || availableKeys.length === 0) return;

    // Check if current key is valid
    const currentKeyValid =
      currentConversationChatApiKey &&
      availableKeys.some((k) => k.id === currentConversationChatApiKeyId);

    // Try to find key from localStorage (use generic key without provider)
    const keyIdFromLocalStorage = localStorage.getItem(LOCAL_STORAGE_KEY);
    const keyFromLocalStorage = keyIdFromLocalStorage
      ? availableKeys.find((k) => k.id === keyIdFromLocalStorage)
      : null;
    const keyToSelect =
      keyFromLocalStorage ||
      keysByScope.personal[0] ||
      keysByScope.team[0] ||
      keysByScope.org_wide[0];
    const keyToSelectValid =
      keyToSelect && availableKeys.some((k) => k.id === keyToSelect.id);

    // Auto-select first key if no valid key is selected
    if (!currentKeyValid && keyToSelectValid) {
      if (conversationId) {
        updateConversationMutation.mutate({
          id: conversationId,
          chatApiKeyId: keyToSelect.id,
        });
      } else if (onApiKeyChange) {
        onApiKeyChange(keyToSelect.id);
      }
      // If selected key is from a different provider, notify parent
      if (onProviderChange && keyToSelect.provider !== currentProvider) {
        onProviderChange(keyToSelect.provider);
      }
    }
  }, [
    availableKeys,
    currentConversationChatApiKeyId,
    isLoading,
    conversationId,
    currentProvider,
    keysByScope,
    onApiKeyChange,
    onProviderChange,
  ]);

  const handleSelectKey = (keyId: string) => {
    if (keyId === currentConversationChatApiKeyId) {
      setOpen(false);
      return;
    }

    // If there are messages, show warning dialog
    if (messageCount > 0) {
      setPendingKeyId(keyId);
    } else {
      applyKeyChange(keyId);
    }
    setOpen(false);
  };

  const applyKeyChange = (keyId: string) => {
    const selectedKey = availableKeys.find((k) => k.id === keyId);

    if (conversationId) {
      updateConversationMutation.mutate({
        id: conversationId,
        chatApiKeyId: keyId,
      });
    } else if (onApiKeyChange) {
      onApiKeyChange(keyId);
    }

    // Save to localStorage (no provider suffix - we show all keys now)
    localStorage.setItem(LOCAL_STORAGE_KEY, keyId);

    // If selected key is from a different provider, switch to that provider's first model
    if (
      selectedKey &&
      onProviderChange &&
      selectedKey.provider !== currentProvider
    ) {
      onProviderChange(selectedKey.provider);
    }
  };

  const handleConfirmChange = () => {
    if (pendingKeyId) {
      applyKeyChange(pendingKeyId);
      setPendingKeyId(null);
    }
  };

  const handleCancelChange = () => {
    setPendingKeyId(null);
  };

  // If no keys available for this provider
  if (!isLoading && availableKeys.length === 0) {
    return null;
  }

  const getKeyDisplayName = (key: ChatApiKey) => {
    if (key.scope === "personal") {
      return key.name;
    }
    if (key.scope === "team") {
      return `${key.name} (${key.teamName || "Team"})`;
    }
    return key.name;
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <PromptInputButton disabled={disabled}>
            <Key className="h-3.5 w-3.5" />
            <span className="truncate max-w-[120px]">
              {currentConversationChatApiKey
                ? getKeyDisplayName(currentConversationChatApiKey)
                : isLoading
                  ? "Loading..."
                  : "Select key"}
            </span>
          </PromptInputButton>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search LLM API Keys..." />
            <CommandList>
              <CommandEmpty>No API keys found.</CommandEmpty>
              {/* Group keys by provider (current provider first) */}
              {orderedProviders.map((provider) => {
                const providerKeys = keysByProviderAndScope[provider];
                const allKeysForProvider = [
                  ...providerKeys.personal,
                  ...providerKeys.team,
                  ...providerKeys.org_wide,
                ];

                if (allKeysForProvider.length === 0) return null;

                return (
                  <CommandGroup
                    key={provider}
                    heading={
                      <div className="flex items-center gap-2">
                        <ProviderIcon src={PROVIDER_CONFIG[provider]?.icon} />
                        <span>{providerDisplayNames[provider]}</span>
                      </div>
                    }
                  >
                    {/* Keys for this provider */}
                    {allKeysForProvider.map((key) => (
                      <CommandItem
                        key={key.id}
                        value={`${key.name} ${key.teamName || ""} ${providerDisplayNames[key.provider]}`}
                        onSelect={() => handleSelectKey(key.id)}
                        className="cursor-pointer"
                      >
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          {SCOPE_ICONS[key.scope]}
                          <span className="truncate">{key.name}</span>
                          {key.scope === "team" && key.teamName && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1 py-0"
                            >
                              {key.teamName}
                            </Badge>
                          )}
                        </div>
                        {currentConversationChatApiKeyId === key.id && (
                          <CheckIcon className="h-4 w-4 shrink-0" />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Mid-conversation warning dialog */}
      <AlertDialog
        open={!!pendingKeyId}
        onOpenChange={(open) => !open && handleCancelChange()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Change API key mid-conversation?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Switching API keys during a conversation may affect billing and
              usage tracking. The new key will be used for all subsequent
              messages.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmChange}>
              Change API Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProviderIcon({ src }: { src?: string }) {
  if (!src) {
    return null;
  }
  return (
    <Image
      src={src}
      alt={"Provider icon"}
      width={16}
      height={16}
      className="rounded shrink-0 dark:invert"
    />
  );
}
