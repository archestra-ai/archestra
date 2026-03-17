"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import { Building2, CheckIcon, Key, User, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
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
  /** Current provider (derived from selected model) - used for auto-selection */
  currentProvider?: SupportedProvider;
  /** Callback when user explicitly selects a key with different provider */
  onProviderChange?: (provider: SupportedProvider, apiKeyId: string) => void;
  /** Callback when the selector opens or closes */
  onOpenChange?: (open: boolean) => void;
  /** Whether models are still loading - don't render until models are loaded */
  isModelsLoading?: boolean;
  /** Agent's configured LLM API key ID - included in available keys even if user lacks direct access */
  agentLlmApiKeyId?: string | null;
}

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

// Note: This stores the API key's database ID (UUID), NOT the actual API key secret.
// The actual API key value is never exposed to the frontend - it's stored securely on the server.
// This ID is just a reference to select which key configuration to use, similar to a userId.

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
  currentProvider,
  onProviderChange,
  onOpenChange,
  isModelsLoading = false,
  agentLlmApiKeyId,
}: ChatApiKeySelectorProps) {
  // Fetch ALL API keys (not filtered by provider) so user can switch providers
  // Include agent's configured key even if user doesn't have direct access
  const { data: availableKeys = [], isLoading: isLoadingKeys } =
    useAvailableChatApiKeys({
      includeKeyId: agentLlmApiKeyId ?? undefined,
    });

  // Combined loading state - wait for both API keys and models
  const isLoading = isLoadingKeys || isModelsLoading;
  const updateConversationMutation = useUpdateConversation();
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };
  // Track which provider we last auto-selected for to prevent infinite loops.
  // Using the provider value (not a boolean) so we can re-run auto-select when
  // the provider genuinely changes (e.g., user picks a model from a different provider)
  // without looping when our own mutations cause provider changes.
  const autoSelectedForProviderRef = useRef<string | null>(null);

  // Group keys by provider for display
  const keysByProvider = useMemo(() => {
    const grouped = {} as Record<SupportedProvider, ChatApiKey[]>;

    for (const key of availableKeys) {
      if (!grouped[key.provider]) {
        grouped[key.provider] = [];
      }
      grouped[key.provider].push(key);
    }

    return grouped;
  }, [availableKeys]);

  // Get available providers sorted (current provider first)
  const availableProviders = useMemo(() => {
    const providers = Object.keys(keysByProvider) as SupportedProvider[];
    // Sort: current provider first, then alphabetically
    return providers.sort((a, b) => {
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      return a.localeCompare(b);
    });
  }, [keysByProvider, currentProvider]);

  // Group keys by scope (personal, team, org_wide) for auto-selection priority
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

  // Reset auto-select tracking when conversation changes so auto-selection
  // re-runs for the new conversation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only resetting on conversationId
  useEffect(() => {
    autoSelectedForProviderRef.current = null;
  }, [conversationId]);

  // Auto-select first key when no key is selected or current key doesn't match provider.
  // Uses provider-based tracking instead of a boolean flag to allow re-selection when the
  // provider genuinely changes (e.g., user picks a model from a different provider) while
  // preventing infinite loops from our own mutations causing provider changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: adding updateConversationMutation as a dependency would cause a infinite loop
  useEffect(() => {
    // Skip if loading or no keys available
    if (isLoading || availableKeys.length === 0) return;

    const providerKey = currentProvider ?? null;

    // Skip if we already handled this exact provider
    if (autoSelectedForProviderRef.current === providerKey) return;

    // Check if current key is valid AND matches the current provider
    const currentKeyValid =
      currentConversationChatApiKey &&
      availableKeys.some((k) => k.id === currentConversationChatApiKeyId) &&
      currentConversationChatApiKey.provider === currentProvider;

    // If current key is valid, mark as handled without firing a mutation
    if (currentKeyValid) {
      autoSelectedForProviderRef.current = providerKey;
      return;
    }

    // Get keys for the current provider (prefer matching provider)
    const providerKeys = currentProvider
      ? (keysByProvider[currentProvider] ?? [])
      : [];

    // Priority: personal > team > org_wide (within current provider)
    const personalKeys = providerKeys.filter((k) => k.scope === "personal");
    const teamKeys = providerKeys.filter((k) => k.scope === "team");
    const orgWideKeys = providerKeys.filter((k) => k.scope === "org_wide");

    const keyToSelect =
      personalKeys[0] ||
      teamKeys[0] ||
      orgWideKeys[0] ||
      // Fall back to any key if no provider-specific key found
      keysByScope.personal[0] ||
      keysByScope.team[0] ||
      keysByScope.org_wide[0];

    const keyToSelectValid =
      keyToSelect && availableKeys.some((k) => k.id === keyToSelect.id);

    // Auto-select key if no valid key is selected
    if (keyToSelectValid) {
      // Mark as handled BEFORE calling callbacks to prevent loops
      autoSelectedForProviderRef.current = providerKey;

      if (conversationId) {
        updateConversationMutation.mutate({
          id: conversationId,
          chatApiKeyId: keyToSelect.id,
        });
      } else if (onApiKeyChange) {
        onApiKeyChange(keyToSelect.id);
      }
    }
  }, [
    availableKeys,
    currentConversationChatApiKeyId,
    currentConversationChatApiKey,
    isLoading,
    conversationId,
    currentProvider,
    keysByProvider,
    keysByScope,
    onApiKeyChange,
  ]);

  const handleSelectKey = (keyId: string) => {
    if (keyId === currentConversationChatApiKeyId) {
      handleOpenChange(false);
      return;
    }

    // If there are messages, show warning dialog
    if (messageCount > 0) {
      setPendingKeyId(keyId);
    } else {
      applyKeyChange(keyId);
    }
    handleOpenChange(false);
  };

  const applyKeyChange = (keyId: string) => {
    // Find the selected key to get its provider
    const selectedKey = availableKeys.find((k) => k.id === keyId);
    const selectedKeyProvider = selectedKey?.provider;

    if (conversationId) {
      // For existing conversations, let onProviderChange handle both the API key
      // update and model selection in a single mutation to avoid race conditions.
      if (selectedKeyProvider && onProviderChange) {
        onProviderChange(selectedKeyProvider, keyId);
      } else {
        updateConversationMutation.mutate({
          id: conversationId,
          chatApiKeyId: keyId,
        });
      }
    } else {
      // For initial (no conversation) state, update key state and notify parent
      if (onApiKeyChange) {
        onApiKeyChange(keyId);
      }
      if (selectedKeyProvider && onProviderChange) {
        onProviderChange(selectedKeyProvider, keyId);
      }
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

  // Don't render until models are loaded (prevents flashing)
  if (isModelsLoading) {
    return null;
  }

  // If no keys available for this provider
  if (!isLoading && availableKeys.length === 0) {
    return null;
  }

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <PromptInputButton
            disabled={disabled}
            className="max-w-[220px] min-w-0"
          >
            <Key className="size-4 shrink-0" />
          </PromptInputButton>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search API Keys..." />
            <CommandList>
              <CommandEmpty>No API keys found.</CommandEmpty>
              {/* Group keys by provider */}
              {availableProviders.map((provider) => (
                <CommandGroup
                  key={provider}
                  heading={
                    providerDisplayNames[provider as SupportedProvider] ??
                    provider
                  }
                >
                  {keysByProvider[provider]?.map((key) => (
                    <CommandItem
                      key={key.id}
                      value={`${provider} ${key.name} ${key.teamName || ""}`}
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
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Mid-conversation warning dialog */}
      <AlertDialog
        open={!!pendingKeyId}
        onOpenChange={(open) => {
          if (!open) {
            handleCancelChange();
            onOpenChange?.(false);
          }
        }}
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
