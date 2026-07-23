"use client";

import {
  CHATGPT_SUBSCRIPTION_LABEL,
  type ResourceVisibilityScope,
  type SupportedProvider,
} from "@archestra/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import type { LlmProviderApiKeyFormValues } from "@/components/llm-provider-api-key-form";
import { useSession } from "@/lib/auth/auth.query";
import { useUpdateConversation } from "@/lib/chat/chat.query";
import {
  type LlmProviderApiKey,
  useAvailableLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

type SubscriptionConnectOption = {
  id: string;
  name: string;
  provider: "openai" | "github-copilot" | "microsoft-365-copilot";
  scope: "personal";
  isChatgptSubscription?: boolean;
  connectRequired: true;
  defaultValues: Partial<LlmProviderApiKeyFormValues>;
};

const SUBSCRIPTION_CONNECT_OPTIONS: SubscriptionConnectOption[] = [
  {
    id: "connect-subscription-openai",
    name: CHATGPT_SUBSCRIPTION_LABEL,
    provider: "openai",
    scope: "personal",
    isChatgptSubscription: true,
    connectRequired: true,
    defaultValues: {
      name: CHATGPT_SUBSCRIPTION_LABEL,
      provider: "openai",
      scope: "personal",
      openaiAuthMethod: "chatgpt-subscription",
    },
  },
  {
    id: "connect-subscription-github-copilot",
    name: "GitHub Copilot",
    provider: "github-copilot",
    scope: "personal",
    connectRequired: true,
    defaultValues: {
      name: "GitHub Copilot",
      provider: "github-copilot",
      scope: "personal",
    },
  },
  {
    id: "connect-subscription-microsoft-365-copilot",
    name: "Microsoft 365 Copilot",
    provider: "microsoft-365-copilot",
    scope: "personal",
    connectRequired: true,
    defaultValues: {
      name: "Microsoft 365 Copilot",
      provider: "microsoft-365-copilot",
      scope: "personal",
    },
  },
];

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
  /** Keep an unconnected subscription pinned instead of selecting a fallback key. */
  suppressAutoSelect?: boolean;
  /** Increment to open the pinned subscription's connection dialog. */
  connectRequestToken?: number;
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
  suppressAutoSelect = false,
  connectRequestToken = 0,
}: LlmProviderApiKeySelectorProps) {
  // Fetch ALL API keys (not filtered by provider) so user can switch providers
  // Include agent's configured key even if user doesn't have direct access
  const { data: fetchedAvailableKeys = [], isLoading: isLoadingKeys } =
    useAvailableLlmProviderApiKeys({
      includeKeyId: agentLlmApiKeyId ?? undefined,
    });
  const { data: session, isPending: isSessionLoading } = useSession();
  const availableKeys = useMemo(
    () =>
      fetchedAvailableKeys.filter(
        (key) =>
          !isPersonalSubscription(key) || key.userId === session?.user.id,
      ),
    [fetchedAvailableKeys, session?.user.id],
  );
  const subscriptionOptions = useMemo(
    () =>
      SUBSCRIPTION_CONNECT_OPTIONS.filter(
        (option) =>
          !availableKeys.some((key) => subscriptionMatchesKey(option, key)),
      ),
    [availableKeys],
  );
  const displayedKeys = useMemo(
    () => [...availableKeys, ...subscriptionOptions],
    [availableKeys, subscriptionOptions],
  );
  const pinnedSubscriptionOption = useMemo(() => {
    if (!agentLlmApiKeyId) return null;
    const pinnedCredential = fetchedAvailableKeys.find(
      (key) => key.id === agentLlmApiKeyId && isPersonalSubscription(key),
    );
    if (!pinnedCredential) return null;
    return (
      subscriptionOptions.find((option) =>
        subscriptionMatchesKey(option, pinnedCredential),
      ) ?? null
    );
  }, [agentLlmApiKeyId, fetchedAvailableKeys, subscriptionOptions]);
  const selectedKeyId =
    currentConversationChatApiKeyId === agentLlmApiKeyId &&
    pinnedSubscriptionOption
      ? pinnedSubscriptionOption.id
      : (currentConversationChatApiKeyId ??
        pinnedSubscriptionOption?.id ??
        null);

  // Combined loading state - wait for both API keys and models
  const isLoading = isLoadingKeys || isSessionLoading || isModelsLoading;
  const updateConversationMutation = useUpdateConversation();
  const [open, setOpen] = useState(false);
  const [subscriptionToConnect, setSubscriptionToConnect] =
    useState<SubscriptionConnectOption | null>(null);
  const [connectedProviderToSelect, setConnectedProviderToSelect] = useState<
    SubscriptionConnectOption["provider"] | null
  >(null);
  const handledConnectRequestRef = useRef(0);
  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  useEffect(() => {
    if (
      connectRequestToken === 0 ||
      connectRequestToken === handledConnectRequestRef.current ||
      !pinnedSubscriptionOption
    ) {
      return;
    }
    handledConnectRequestRef.current = connectRequestToken;
    setSubscriptionToConnect(pinnedSubscriptionOption);
    setOpen(false);
    onOpenChange?.(false);
  }, [connectRequestToken, onOpenChange, pinnedSubscriptionOption]);
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
    if (suppressAutoSelect || isLoading || availableKeys.length === 0) return;

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
      subscriptionDebug("credential auto-select", {
        conversationId: conversationId ?? null,
        currentProvider: currentProvider ?? null,
        previousChatApiKeyId: currentConversationChatApiKeyId,
        nextChatApiKeyId: keyToSelect.id,
        nextProvider: keyToSelect.provider,
        suppressAutoSelect,
      });

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
    suppressAutoSelect,
  ]);

  const applyKeyChange = useCallback(
    (keyId: string) => {
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
    },
    [
      availableKeys,
      conversationId,
      onApiKeyChange,
      onProviderChange,
      updateConversationMutation,
    ],
  );

  useEffect(() => {
    if (!connectedProviderToSelect) return;
    const connectedKey = availableKeys.find((key) =>
      subscriptionMatchesProvider(connectedProviderToSelect, key),
    );
    if (!connectedKey) return;

    applyKeyChange(connectedKey.id);
    setConnectedProviderToSelect(null);
  }, [availableKeys, applyKeyChange, connectedProviderToSelect]);

  const handleSelectKey = (keyId: string) => {
    const connectOption = subscriptionOptions.find(
      (option) => option.id === keyId,
    );
    if (connectOption) {
      setSubscriptionToConnect(connectOption);
      handleOpenChange(false);
      return;
    }
    if (keyId === currentConversationChatApiKeyId) {
      handleOpenChange(false);
      return;
    }

    applyKeyChange(keyId);
    handleOpenChange(false);
  };

  // Don't render until models are loaded (prevents flashing)
  if (isModelsLoading) {
    return null;
  }

  return (
    <>
      <LlmProviderApiKeyDropdown
        availableKeys={displayedKeys}
        selectedApiKeyId={selectedKeyId}
        disabled={disabled}
        open={open}
        onOpenChange={handleOpenChange}
        onSelectKey={handleSelectKey}
        currentProvider={currentProvider}
        searchPlaceholder="Search credentials..."
        showChatTestIds
      />
      {subscriptionToConnect && (
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={(dialogOpen) => {
            if (!dialogOpen) setSubscriptionToConnect(null);
          }}
          title={`Connect ${subscriptionToConnect.name}`}
          description={`Connect your ${subscriptionToConnect.name} subscription`}
          defaultValues={subscriptionToConnect.defaultValues}
          allowedProviders={[subscriptionToConnect.provider]}
          onSuccess={() =>
            setConnectedProviderToSelect(subscriptionToConnect.provider)
          }
        />
      )}
    </>
  );
}

function isPersonalSubscription(key: LlmProviderApiKey) {
  return (
    isChatgptSubscription(key) ||
    key.provider === "github-copilot" ||
    key.provider === "microsoft-365-copilot"
  );
}

function subscriptionMatchesKey(
  option: SubscriptionConnectOption,
  key: LlmProviderApiKey,
) {
  return subscriptionMatchesProvider(option.provider, key);
}

function subscriptionMatchesProvider(
  provider: SubscriptionConnectOption["provider"],
  key: LlmProviderApiKey,
) {
  return provider === "openai"
    ? isChatgptSubscription(key)
    : key.provider === provider;
}

function isChatgptSubscription(key: LlmProviderApiKey) {
  return (
    key.provider === "openai" &&
    (key.isChatgptSubscription === true ||
      key.name.trim().toLowerCase() === "chatgpt subscription")
  );
}

function subscriptionDebug(event: string, data: Record<string, unknown>) {
  console.info(`[subscription-debug] ${event}`, data);
}
