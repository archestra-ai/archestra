"use client";

import {
  type ResourceVisibilityScope,
  SUBSCRIPTION_CREDENTIAL_KINDS,
  SUBSCRIPTION_CREDENTIALS,
  type SubscriptionCredentialKind,
  type SupportedProvider,
  subscriptionKindFromKeyMetadata,
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
  subscriptionKind: SubscriptionCredentialKind;
  name: string;
  provider: (typeof SUBSCRIPTION_CREDENTIALS)[SubscriptionCredentialKind]["provider"];
  scope: "personal";
  connectRequired: true;
  dialogTitle: string;
  dialogDescription: string;
  defaultValues: Partial<LlmProviderApiKeyFormValues>;
};

/**
 * The "Connect subscription" entries offered in the selector, derived from the
 * shared registry so a new subscription appears here without editing this
 * component.
 */
const SUBSCRIPTION_CONNECT_OPTIONS: SubscriptionConnectOption[] =
  SUBSCRIPTION_CREDENTIAL_KINDS.map((kind) => {
    const { provider, label, marker, connect } = SUBSCRIPTION_CREDENTIALS[kind];
    return {
      id: `connect-subscription-${kind}`,
      subscriptionKind: kind,
      name: label,
      provider,
      scope: "personal" as const,
      connectRequired: true as const,
      dialogTitle: connect.signInTitle,
      dialogDescription: connect.signInDescription,
      defaultValues: {
        name: label,
        provider,
        scope: "personal" as const,
        // Credential-level subscriptions share their provider with ordinary
        // API keys, so the form has to open on the subscription tab.
        // Provider-level ones have no tabs and ignore this.
        ...(marker !== null ? { authMethod: "subscription" as const } : {}),
      },
    };
  });

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
  // Set when the connect dialog re-authenticates an existing credential
  // (rotating its secret) instead of creating a new one.
  const [reconnectKeyId, setReconnectKeyId] = useState<string | null>(null);
  const [connectedKindToSelect, setConnectedKindToSelect] =
    useState<SubscriptionCredentialKind | null>(null);
  const [isCreateApiKeyDialogOpen, setIsCreateApiKeyDialogOpen] =
    useState(false);
  const [createdKeyIdToSelect, setCreatedKeyIdToSelect] = useState<
    string | null
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
    if (!connectedKindToSelect) return;
    const connectedKey = availableKeys.find((key) =>
      subscriptionMatchesKind(connectedKindToSelect, key),
    );
    if (!connectedKey) return;

    applyKeyChange(connectedKey.id);
    setConnectedKindToSelect(null);
  }, [availableKeys, applyKeyChange, connectedKindToSelect]);

  useEffect(() => {
    if (!createdKeyIdToSelect) return;
    if (!availableKeys.some((key) => key.id === createdKeyIdToSelect)) return;

    applyKeyChange(createdKeyIdToSelect);
    setCreatedKeyIdToSelect(null);
  }, [availableKeys, applyKeyChange, createdKeyIdToSelect]);

  const handleSelectKey = (keyId: string) => {
    setCreatedKeyIdToSelect(null);
    const connectOption = subscriptionOptions.find(
      (option) => option.id === keyId,
    );
    if (connectOption) {
      setReconnectKeyId(null);
      setSubscriptionToConnect(connectOption);
      handleOpenChange(false);
      return;
    }
    if (keyId === currentConversationChatApiKeyId) {
      // Re-clicking the selected credential: for a connected personal
      // subscription, open the sign-in dialog again so an expired or revoked
      // session can be re-authenticated (otherwise the click is a dead end).
      const selectedKey = availableKeys.find((key) => key.id === keyId);
      const reconnectOption =
        selectedKey && isPersonalSubscription(selectedKey)
          ? SUBSCRIPTION_CONNECT_OPTIONS.find((option) =>
              subscriptionMatchesKey(option, selectedKey),
            )
          : undefined;
      if (reconnectOption) {
        setReconnectKeyId(keyId);
        setSubscriptionToConnect({
          ...reconnectOption,
          dialogTitle: `Reconnect ${reconnectOption.name}`,
          dialogDescription:
            "Sign in again to refresh this connection. The saved credential is replaced.",
        });
      }
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
        onAddApiKey={() => {
          setCreatedKeyIdToSelect(null);
          handleOpenChange(false);
          setIsCreateApiKeyDialogOpen(true);
        }}
        currentProvider={currentProvider}
        searchPlaceholder="Search credentials..."
        showChatTestIds
      />
      <CreateLlmProviderApiKeyDialog
        open={isCreateApiKeyDialogOpen}
        onOpenChange={setIsCreateApiKeyDialogOpen}
        title="Add API Key"
        description="Add an LLM provider API key and use it in this chat"
        credentialMode="api-key"
        showConsoleLink
        onSuccess={(keyId) => {
          if (keyId) setCreatedKeyIdToSelect(keyId);
        }}
      />
      {subscriptionToConnect && (
        <CreateLlmProviderApiKeyDialog
          open
          onOpenChange={(dialogOpen) => {
            if (!dialogOpen) {
              setSubscriptionToConnect(null);
              setReconnectKeyId(null);
            }
          }}
          title={subscriptionToConnect.dialogTitle}
          description={subscriptionToConnect.dialogDescription}
          defaultValues={subscriptionToConnect.defaultValues}
          allowedProviders={[subscriptionToConnect.provider]}
          credentialMode="subscription"
          requiresExactSubscriptionCredential={Boolean(
            pinnedSubscriptionOption &&
              pinnedSubscriptionOption.subscriptionKind ===
                subscriptionToConnect.subscriptionKind,
          )}
          reconnectKeyId={reconnectKeyId ?? undefined}
          onSuccess={() =>
            setConnectedKindToSelect(subscriptionToConnect.subscriptionKind)
          }
        />
      )}
    </>
  );
}

function isPersonalSubscription(key: LlmProviderApiKey) {
  return SUBSCRIPTION_CREDENTIAL_KINDS.some((kind) =>
    subscriptionMatchesKind(kind, key),
  );
}

function subscriptionMatchesKey(
  option: SubscriptionConnectOption,
  key: LlmProviderApiKey,
) {
  return subscriptionMatchesKind(option.subscriptionKind, key);
}

/**
 * Whether a stored key IS the given subscription. A provider-level subscription
 * (no marker) owns its provider outright, so the provider identifies it; a
 * credential-level one shares its provider with ordinary API keys, so it must
 * match on the kind the backend read off the stored secret — a plain xAI or
 * OpenAI API key never matches.
 */
function subscriptionMatchesKind(
  kind: SubscriptionCredentialKind,
  key: LlmProviderApiKey,
) {
  const { provider, marker } = SUBSCRIPTION_CREDENTIALS[kind];
  if (key.provider !== provider) return false;
  if (marker === null) return true;
  // The metadata helper consumes only the authoritative server-derived kind.
  return subscriptionKindFromKeyMetadata(key) === kind;
}

function subscriptionDebug(event: string, data: Record<string, unknown>) {
  console.info(`[subscription-debug] ${event}`, data);
}
