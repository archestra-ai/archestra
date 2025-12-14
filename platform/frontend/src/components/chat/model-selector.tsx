"use client";

import { modelsByProvider, providerDisplayNames, type ChatProvider } from "@shared";
import { useState } from "react";
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
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useChatApiKeysOptional } from "@/lib/chat-settings.query";
import { useFeatures } from "@/lib/features.query";

interface ModelSelectorProps {
    /** Currently selected model */
    selectedModel: string;
    /** Callback when model is changed */
    onModelChange: (model: string) => void;
    /** Whether the selector should be disabled */
    disabled?: boolean;
    /** Number of messages in current conversation (for mid-conversation warning) */
    messageCount?: number;
    /** Additional className for the trigger */
    className?: string;
}

/**
 * Model selector dropdown with:
 * - Models filtered by configured API keys
 * - Mid-conversation warning when switching models

 */
export function ModelSelector({
    selectedModel,
    onModelChange,
    disabled = false,
    messageCount = 0,
    className,
}: ModelSelectorProps) {
    const { data: chatApiKeys = [] } = useChatApiKeysOptional();
    const { data: features } = useFeatures();
    const [pendingModel, setPendingModel] = useState<string | null>(null);

    // Determine which providers have API keys configured
    const configuredProviders = new Set<ChatProvider>();

    // Check API keys for each provider
    for (const key of chatApiKeys) {
        if (key.secretId && key.provider) {
            configuredProviders.add(key.provider as ChatProvider);
        }
    }

    // Gemini with Vertex AI doesn't require an API key
    if (features?.geminiVertexAiEnabled) {
        configuredProviders.add("gemini");
    }

    // Build available models based on configured providers
    const availableProviders = (Object.keys(modelsByProvider) as ChatProvider[]).filter(
        (provider) => configuredProviders.has(provider)
    );

    const handleValueChange = (model: string) => {
        // If there are messages, show warning dialog
        if (messageCount > 0) {
            setPendingModel(model);
        } else {
            onModelChange(model);
        }
    };

    const handleConfirmChange = () => {
        if (pendingModel) {
            onModelChange(pendingModel);
            setPendingModel(null);
        }
    };

    const handleCancelChange = () => {
        setPendingModel(null);
    };

    // If no providers configured, show disabled state
    if (availableProviders.length === 0) {
        return (
            <Select disabled>
                <SelectTrigger size="sm" className={className}>
                    <SelectValue placeholder="No API keys configured" />
                </SelectTrigger>
            </Select>
        );
    }

    return (
        <>
            <Select
                value={selectedModel}
                onValueChange={handleValueChange}
                disabled={disabled}
            >
                <SelectTrigger size="sm" className={className}>
                    <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                    {availableProviders.map((provider, index) => (
                        <div key={provider}>
                            {index > 0 && <SelectSeparator />}
                            <SelectGroup>
                                <SelectLabel>{providerDisplayNames[provider]}</SelectLabel>
                                {modelsByProvider[provider].map((model) => (
                                    <SelectItem key={model} value={model}>
                                        {model}
                                    </SelectItem>
                                ))}
                            </SelectGroup>
                        </div>
                    ))}
                </SelectContent>
            </Select>

            {/* Mid-conversation warning dialog */}
            <AlertDialog open={!!pendingModel} onOpenChange={(open) => !open && handleCancelChange()}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Change model mid-conversation?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Switching models during a conversation may affect response quality and
                            consistency. The new model may not have the same context understanding as
                            the previous one.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={handleConfirmChange}>
                            Change Model
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}
