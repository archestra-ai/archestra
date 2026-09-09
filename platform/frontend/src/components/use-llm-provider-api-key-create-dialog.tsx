"use client";

import type { SupportedProvider } from "@archestra/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import type { LlmProviderApiKey } from "@/lib/llm-provider-api-keys.query";

/**
 * Owns the provider-key creation lifecycle for selectors. A created key is
 * selected only after the caller's available-key query includes it, so callers
 * never select a key they cannot yet resolve.
 */
export function useLlmProviderApiKeyCreateDialog({
  availableKeys,
  onSelectKey,
  onBeforeOpen,
  allowedProviders,
}: {
  availableKeys: LlmProviderApiKey[];
  onSelectKey: (keyId: string) => void;
  onBeforeOpen?: () => void;
  allowedProviders?: SupportedProvider[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [createdKeyToSelect, setCreatedKeyToSelect] = useState<{
    id: string;
    version: number;
  } | null>(null);
  const selectionVersionRef = useRef(0);

  const cancelPendingCreatedKeySelection = useCallback(() => {
    selectionVersionRef.current += 1;
    setCreatedKeyToSelect(null);
  }, []);

  const onAddApiKey = useCallback(() => {
    cancelPendingCreatedKeySelection();
    onBeforeOpen?.();
    setIsOpen(true);
  }, [cancelPendingCreatedKeySelection, onBeforeOpen]);

  useEffect(() => {
    if (!createdKeyToSelect) return;
    const createdKey = availableKeys.find(
      (key) => key.id === createdKeyToSelect.id,
    );
    if (!createdKey) return;
    if (createdKeyToSelect.version !== selectionVersionRef.current) return;

    setCreatedKeyToSelect(null);
    if (!allowedProviders || allowedProviders.includes(createdKey.provider)) {
      onSelectKey(createdKey.id);
    }
  }, [allowedProviders, availableKeys, createdKeyToSelect, onSelectKey]);

  return {
    cancelPendingCreatedKeySelection,
    onAddApiKey,
    createDialog: (
      <CreateLlmProviderApiKeyDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        title="Add API Key"
        description="Add an LLM provider API key."
        allowedProviders={allowedProviders}
        credentialMode="api-key"
        showConsoleLink
        onSuccess={(keyId) => {
          if (keyId) {
            setCreatedKeyToSelect({
              id: keyId,
              version: selectionVersionRef.current,
            });
          }
        }}
      />
    ),
  };
}
