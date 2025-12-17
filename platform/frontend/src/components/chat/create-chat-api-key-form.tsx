"use client";

import type { archestraApiTypes } from "@shared";
import { CheckCircle2, Loader2 } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useChatApiKeys, useCreateChatApiKey } from "@/lib/chat-settings.query";

type SupportedChatProvider =
  archestraApiTypes.GetChatApiKeysResponses["200"][number]["provider"];

const PROVIDER_CONFIG: Record<
  SupportedChatProvider,
  {
    name: string;
    icon: string;
    placeholder: string;
    enabled: boolean;
    consoleUrl: string;
    consoleName: string;
  }
> = {
  anthropic: {
    name: "Anthropic",
    icon: "/icons/anthropic.png",
    placeholder: "sk-ant-...",
    enabled: true,
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleName: "Anthropic Console",
  },
  openai: {
    name: "OpenAI",
    icon: "/icons/openai.png",
    placeholder: "sk-...",
    enabled: true,
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleName: "OpenAI Platform",
  },
  gemini: {
    name: "Gemini",
    icon: "/icons/gemini.png",
    placeholder: "AIza...",
    enabled: true,
    consoleUrl: "https://aistudio.google.com/app/apikey",
    consoleName: "Google AI Studio",
  },
} as const;

export { PROVIDER_CONFIG };
export type { SupportedChatProvider };

interface CreateChatApiKeyFormProps {
  /**
   * Variant of the form
   * - "full": Shows all fields including name and set as default checkbox
   * - "compact": Shows only provider and API key fields, auto-sets name and default
   */
  variant?: "full" | "compact";
  /**
   * Callback when API key is successfully created
   */
  onSuccess?: () => void;
  /**
   * Whether to show the console link for getting API keys
   */
  showConsoleLink?: boolean;
}

const PLACEHOLDER_KEY = "••••••••••••••••";

export function CreateChatApiKeyForm({
  variant = "full",
  onSuccess,
  showConsoleLink = true,
}: CreateChatApiKeyFormProps) {
  const { data: chatApiKeys = [] } = useChatApiKeys();
  const createChatApiKey = useCreateChatApiKey();

  const [provider, setProvider] = useState<SupportedChatProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [hasApiKeyChanged, setHasApiKeyChanged] = useState(false);

  // Check if any API key is configured for the selected provider
  const hasExistingApiKey = useMemo(() => {
    return chatApiKeys.some((k) => k.provider === provider && k.secretId);
  }, [chatApiKeys, provider]);

  // Set placeholder dots when API key is configured
  useEffect(() => {
    if (hasExistingApiKey) {
      setApiKey(PLACEHOLDER_KEY);
      setHasApiKeyChanged(false);
    } else {
      setApiKey("");
      setHasApiKeyChanged(false);
    }
  }, [hasExistingApiKey]);

  const handleApiKeyChange = useCallback(
    (value: string) => {
      setApiKey(value);
      if (hasExistingApiKey) {
        setHasApiKeyChanged(value !== PLACEHOLDER_KEY);
      } else {
        setHasApiKeyChanged(value !== "");
      }
    },
    [hasExistingApiKey],
  );

  const handleSubmit = useCallback(async () => {
    try {
      const keyToSend = hasApiKeyChanged ? apiKey : undefined;
      if (!keyToSend) return;

      const keyName =
        variant === "compact"
          ? `Default ${PROVIDER_CONFIG[provider].name} Key`
          : name;

      await createChatApiKey.mutateAsync({
        name: keyName,
        provider,
        apiKey: keyToSend,
        isOrganizationDefault: variant === "compact" ? true : isDefault,
      });

      toast.success("API key saved successfully");
      setApiKey(PLACEHOLDER_KEY);
      setHasApiKeyChanged(false);
      if (variant === "full") {
        setName("");
        setIsDefault(false);
      }
      onSuccess?.();
    } catch (_error) {
      toast.error("Failed to save API key");
    }
  }, [
    hasApiKeyChanged,
    apiKey,
    name,
    provider,
    isDefault,
    createChatApiKey,
    variant,
    onSuccess,
  ]);

  const providerConfig = PROVIDER_CONFIG[provider];

  return (
    <div className="space-y-3">
      {variant === "full" && (
        <div className="space-y-2">
          <Label htmlFor="create-api-key-name">Name</Label>
          <Input
            id="create-api-key-name"
            placeholder={`My ${providerConfig.name} Key`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="create-api-key-provider">Provider</Label>
        <Select
          value={provider}
          onValueChange={(v) => setProvider(v as SupportedChatProvider)}
        >
          <SelectTrigger id="create-api-key-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PROVIDER_CONFIG).map(([key, config]) => (
              <SelectItem key={key} value={key} disabled={!config.enabled}>
                <div className="flex items-center gap-2">
                  <Image
                    src={config.icon}
                    alt={config.name}
                    width={16}
                    height={16}
                    className="rounded"
                  />
                  <span>{config.name}</span>
                  {!config.enabled && (
                    <Badge variant="outline" className="ml-2 text-xs">
                      Coming Soon
                    </Badge>
                  )}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="create-api-key-value">API Key</Label>
        <div className="relative">
          <Input
            id="create-api-key-value"
            type="password"
            placeholder={providerConfig.placeholder}
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            className={
              hasExistingApiKey && !hasApiKeyChanged
                ? "border-green-500 pr-10"
                : ""
            }
          />
          {hasExistingApiKey && !hasApiKeyChanged && (
            <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
          )}
        </div>
        {showConsoleLink && (
          <p className="text-xs text-muted-foreground">
            Get your API key from{" "}
            <Link
              href={providerConfig.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {providerConfig.consoleName}
            </Link>
          </p>
        )}
      </div>

      {variant === "full" && (
        <div className="flex items-center space-x-2">
          <Checkbox
            id="create-api-key-default"
            checked={isDefault}
            onCheckedChange={(checked) => setIsDefault(checked === true)}
          />
          <Label
            htmlFor="create-api-key-default"
            className="text-sm font-normal"
          >
            Set as organization default for {providerConfig.name}
          </Label>
        </div>
      )}

      <Button
        onClick={handleSubmit}
        disabled={
          createChatApiKey.isPending ||
          !apiKey ||
          !hasApiKeyChanged ||
          (variant === "full" && !name)
        }
        size="sm"
      >
        {createChatApiKey.isPending && (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        )}
        {hasExistingApiKey ? "Update API Key" : "Save API Key"}
      </Button>
    </div>
  );
}
