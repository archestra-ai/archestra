"use client";

import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useChatSettings,
  useUpdateChatSettings,
} from "@/lib/chat-settings.query";

const PLACEHOLDER_KEY = "••••••••••••••••";

function ChatSettingsContent() {
  const { data: chatSettings } = useChatSettings();
  const updateChatSettings = useUpdateChatSettings();

  const [apiKey, setApiKey] = useState("");
  const [hasApiKeyChanged, setHasApiKeyChanged] = useState(false);

  // Set placeholder dots when API key is configured
  useEffect(() => {
    if (chatSettings?.anthropicApiKeySecretId) {
      setApiKey(PLACEHOLDER_KEY);
      setHasApiKeyChanged(false);
    }
  }, [chatSettings?.anthropicApiKeySecretId]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      // Mark as changed if user modified the field
      if (chatSettings?.anthropicApiKeySecretId) {
        // If key exists, changed means it's different from placeholder
        setHasApiKeyChanged(value !== PLACEHOLDER_KEY);
      } else {
        // If no key exists, any non-empty value is a change
        setHasApiKeyChanged(value !== "");
      }
    },
    [chatSettings?.anthropicApiKeySecretId],
  );

  const handleSaveApiKey = useCallback(async () => {
    try {
      // Only send the API key if it's been changed from the placeholder
      const keyToSend = hasApiKeyChanged ? apiKey : undefined;

      await updateChatSettings.mutateAsync({
        anthropicApiKey: keyToSend,
      });
      toast.success("API key saved successfully");

      // Reset to placeholder dots if key was configured
      if (chatSettings?.anthropicApiKeySecretId || keyToSend) {
        setApiKey(PLACEHOLDER_KEY);
        setHasApiKeyChanged(false);
      } else {
        setApiKey("");
      }
    } catch (_error) {
      toast.error("Failed to save API key");
    }
  }, [
    chatSettings?.anthropicApiKeySecretId,
    hasApiKeyChanged,
    apiKey,
    updateChatSettings,
  ]);

  const handleCancelApiKey = useCallback(() => {
    // Reset to placeholder dots if key exists, otherwise empty
    if (chatSettings?.anthropicApiKeySecretId) {
      setApiKey(PLACEHOLDER_KEY);
    } else {
      setApiKey("");
    }
    setHasApiKeyChanged(false);
  }, [chatSettings?.anthropicApiKeySecretId]);

  const handleResetApiKey = useCallback(async () => {
    if (
      !confirm(
        "Are you sure you want to reset the Anthropic API key? Chat functionality will stop working until a new key is configured.",
      )
    ) {
      return;
    }

    try {
      await updateChatSettings.mutateAsync({
        resetApiKey: true,
      });
      toast.success("API key reset successfully");
      setApiKey("");
      setHasApiKeyChanged(false);
    } catch (_error) {
      toast.error("Failed to reset API key");
    }
  }, [updateChatSettings]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Anthropic API Key</CardTitle>
          <CardDescription>
            Configure the Anthropic API key for chat functionality
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="apiKey">API Key</Label>
            <div className="relative">
              <Input
                id="apiKey"
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                className={
                  chatSettings?.anthropicApiKeySecretId && !hasApiKeyChanged
                    ? "border-green-500 pr-10"
                    : ""
                }
              />
              {chatSettings?.anthropicApiKeySecretId && !hasApiKeyChanged && (
                <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
              )}
            </div>
          </div>
          {hasApiKeyChanged ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleCancelApiKey}
                disabled={updateChatSettings.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSaveApiKey}
                disabled={updateChatSettings.isPending || !apiKey}
              >
                {updateChatSettings.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {chatSettings?.anthropicApiKeySecretId
                  ? "Update API Key"
                  : "Save API Key"}
              </Button>
            </div>
          ) : (
            chatSettings?.anthropicApiKeySecretId && (
              <Button
                variant="destructive"
                onClick={handleResetApiKey}
                disabled={updateChatSettings.isPending}
              >
                {updateChatSettings.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                <RotateCcw className="mr-2 h-4 w-4" />
                Reset API Key
              </Button>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ChatSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin" />
        </div>
      }
    >
      <ChatSettingsContent />
    </Suspense>
  );
}
