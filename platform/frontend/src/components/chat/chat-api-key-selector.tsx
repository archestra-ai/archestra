"use client";

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
  type SupportedChatProvider,
  useAvailableChatApiKeys,
} from "@/lib/chat-settings.query";
import { useFeatureFlag } from "@/lib/features.hook";

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
  /** Current provider (derived from selected model) - used to filter API keys */
  currentProvider?: SupportedChatProvider;
  /** Callback when the selector opens or closes */
  onOpenChange?: (open: boolean) => void;
  /** Whether models are still loading - don't render until models are loaded */
  isModelsLoading?: boolean;
}

const SCOPE_ICONS: Record<ChatApiKeyScope, React.ReactNode> = {
  personal: <User className="h-3 w-3" />,
  team: <Users className="h-3 w-3" />,
  org_wide: <Building2 className="h-3 w-3" />,
};

// Note: This stores the API key's database ID (UUID), NOT the actual API key secret.
// The actual API key value is never exposed to the frontend - it's stored securely on the server.
// This ID is just a reference to select which key configuration to use, similar to a userId.
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
  currentProvider,
  onOpenChange,
  isModelsLoading = false,
}: ChatApiKeySelectorProps) {
  // Check if Vertex AI is enabled for Gemini (uses ADC, no API key needed)
  const geminiVertexAiEnabled = useFeatureFlag("geminiVertexAiEnabled");

  // Fetch API keys for the current provider only
  const { data: availableKeys = [], isLoading: isLoadingKeys } =
    useAvailableChatApiKeys(currentProvider);

  // Combined loading state - wait for both API keys and models
  const isLoading = isLoadingKeys || isModelsLoading;
  const updateConversationMutation = useUpdateConversation();
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };
  // Track if we've already auto-selected to prevent infinite loops
  const hasAutoSelectedRef = useRef(false);

  // Group keys by scope (personal, team, org_wide)
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

  // Reset auto-select flag when conversation context changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to reset when conversationId changes
  useEffect(() => {
    hasAutoSelectedRef.current = false;
  }, [conversationId]);

  // Auto-select first key when no key is selected or current key is invalid
  // biome-ignore lint/correctness/useExhaustiveDependencies: adding updateConversationMutation as a dependency would cause a infinite loop
  useEffect(() => {
    // Skip if loading or no keys available
    if (isLoading || availableKeys.length === 0) return;

    // Skip if we've already auto-selected to prevent infinite loops
    if (hasAutoSelectedRef.current) return;

    // Check if current key is valid
    const currentKeyValid =
      currentConversationChatApiKey &&
      availableKeys.some((k) => k.id === currentConversationChatApiKeyId);

    // Try to find key from localStorage (per-provider key)
    const localStorageKey = currentProvider
      ? `${LOCAL_STORAGE_KEY}-${currentProvider}`
      : LOCAL_STORAGE_KEY;
    const keyIdFromLocalStorage = localStorage.getItem(localStorageKey);
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
      // Mark as auto-selected BEFORE calling callbacks to prevent loops
      hasAutoSelectedRef.current = true;

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
    if (conversationId) {
      updateConversationMutation.mutate({
        id: conversationId,
        chatApiKeyId: keyId,
      });
    } else if (onApiKeyChange) {
      onApiKeyChange(keyId);
    }

    // Save to localStorage for this provider
    if (currentProvider) {
      localStorage.setItem(`${LOCAL_STORAGE_KEY}-${currentProvider}`, keyId);
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

  // Hide for Gemini with Vertex AI enabled (uses ADC, no API key needed)
  if (currentProvider === "gemini" && geminiVertexAiEnabled) {
    return null;
  }

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
      <Popover open={open} onOpenChange={handleOpenChange}>
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
            <CommandInput placeholder="Search API Keys..." />
            <CommandList>
              <CommandEmpty>No API keys found.</CommandEmpty>
              {/* Show all keys for the current provider */}
              <CommandGroup>
                {availableKeys.map((key) => (
                  <CommandItem
                    key={key.id}
                    value={`${key.name} ${key.teamName || ""}`}
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
