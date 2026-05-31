"use client";

import type { ResourceVisibilityScope, SupportedProvider } from "@shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import {
  type LlmProviderApiKey,
  useAvailableLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

interface LlmProviderApiKeySelectorProps {
  /** Conversation ID for persisting selection (optional for initial chat) */
  conversationId?: string;
  /** Current Conversation Chat API key ID set on the backend */
  currentConversationChatApiKeyId: string | null;
  /** Whether the selector should be disabled */
  disabled?: boolean;
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

/**
 * API Key selector for chat - allows users to select which API key to use for the conversation.
 * Shows available keys for the current provider, grouped by scope.
 */
export function LlmProviderApiKeySelector({
  conversationId,
  currentConversationChatApiKeyId,
  disabled = false,
  onApiKeyChange,
  currentProvider,
  onProviderChange,
  onOpenChange,
  isModelsLoading = false,
  agentLlmApiKeyId,
}: LlmProviderApiKeySelectorProps) {
  // Fetch ALL API keys (not filtered by provider) so user can switch providers
  // Include agent's configured key even if user doesn't have direct access
  const { data: availableKeys = [], isLoading: isLoadingKeys } =
    useAvailableLlmProviderApiKeys({
      includeKeyId: agentLlmApiKeyId ?? undefined,
    });

  // Combined loading state - wait for both API keys and models
  const isLoading = isLoadingKeys || isModelsLoading;
  const updateConversationMutation = useUpdateConversation();
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

  // Group keys by scope (personal, team, org) for auto-selection priority
  const keysByScope = useMemo(() => {
    const grouped: Record<ResourceVisibilityScope, LlmProviderApiKey[]> = {
      personal: [],
      team: [],
      org: [],
    };

    for (const key of availableKeys) {
      grouped[key.scope].push(key);
    }

    return grouped;
  }, [availableKeys]);

  const providerKeys = useMemo(() => {
    if (!currentProvider) return [];
    return availableKeys.filter((key) => key.provider === currentProvider);
  }, [availableKeys, currentProvider]);

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

    // Priority: personal > team > org (within current provider)
    const personalKeys = providerKeys.filter((k) => k.scope === "personal");
    const teamKeys = providerKeys.filter((k) => k.scope === "team");
    const orgWideKeys = providerKeys.filter((k) => k.scope === "org");

    const keyToSelect =
      personalKeys[0] ||
      teamKeys[0] ||
      orgWideKeys[0] ||
      // Fall back to any key if no provider-specific key found
      keysByScope.personal[0] ||
      keysByScope.team[0] ||
      keysByScope.org[0];

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
    providerKeys,
    keysByScope,
    onApiKeyChange,
  ]);

  const handleSelectKey = (keyId: string) => {
    if (keyId === currentConversationChatApiKeyId) {
      handleOpenChange(false);
      return;
    }

    applyKeyChange(keyId);
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

  // Don't render until models are loaded (prevents flashing)
  if (isModelsLoading) {
    return null;
  }

  // If no keys available for this provider
  if (!isLoading && availableKeys.length === 0) {
    return null;
  }

  return (
    <LlmProviderApiKeyDropdown
      availableKeys={availableKeys}
      selectedApiKeyId={currentConversationChatApiKeyId}
      disabled={disabled}
      open={open}
      onOpenChange={handleOpenChange}
      onSelectKey={handleSelectKey}
      currentProvider={currentProvider}
      showChatTestIds
    />
  );
}
