"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { ConnectionBaseUrlSelect } from "@/components/connection-base-url-select";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import config from "@/lib/config";

const { externalProxyUrls, internalProxyUrl } = config.api;

type ProviderOption = SupportedProvider | "claude-code";

/** Provider configuration for URL replacement instructions */
const PROVIDER_CONFIG: Record<
  ProviderOption,
  { label: string; originalUrl: string } | { label: string; isCommand: true }
> = {
  openai: {
    label: providerDisplayNames.openai,
    originalUrl: "https://api.openai.com/v1/",
  },
  gemini: {
    label: providerDisplayNames.gemini,
    originalUrl: "https://generativelanguage.googleapis.com/v1/",
  },
  anthropic: {
    label: providerDisplayNames.anthropic,
    originalUrl: "https://api.anthropic.com/v1/",
  },
  cerebras: {
    label: providerDisplayNames.cerebras,
    originalUrl: "https://api.cerebras.ai/v1/",
  },
  mistral: {
    label: providerDisplayNames.mistral,
    originalUrl: "https://api.mistral.ai/v1/",
  },
  cohere: {
    label: providerDisplayNames.cohere,
    originalUrl: "https://api.cohere.com/v2/",
  },
  vllm: {
    label: providerDisplayNames.vllm,
    originalUrl: "http://localhost:8000/v1/",
  },
  ollama: {
    label: providerDisplayNames.ollama,
    originalUrl: "http://localhost:11434/v1/",
  },
  zhipuai: {
    label: providerDisplayNames.zhipuai,
    originalUrl: "https://open.bigmodel.cn/api/",
  },
  "claude-code": { label: "Claude Code", isCommand: true },
};

/** Providers to show as buttons (subset of all providers) */
const VISIBLE_PROVIDERS: ProviderOption[] = [
  "openai",
  "gemini",
  "anthropic",
  "cerebras",
  "claude-code",
  "mistral",
];

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderOption>("openai");
  const [connectionUrl, setConnectionUrl] = useState<string>(
    externalProxyUrls.length >= 1 ? externalProxyUrls[0] : internalProxyUrl,
  );

  const getProviderPath = (provider: ProviderOption) =>
    provider === "claude-code" ? "anthropic" : provider;

  const proxyUrl = agentId
    ? `${connectionUrl}/${getProviderPath(selectedProvider)}/${agentId}`
    : `${connectionUrl}/${getProviderPath(selectedProvider)}`;

  const claudeCodeCommand = `ANTHROPIC_BASE_URL=${connectionUrl}/anthropic${agentId ? `/${agentId}` : ""} claude`;

  const providerConfig = PROVIDER_CONFIG[selectedProvider];

  return (
    <div className="space-y-3">
      <ButtonGroup>
        {VISIBLE_PROVIDERS.map((provider) => (
          <Button
            key={provider}
            variant={selectedProvider === provider ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedProvider(provider)}
          >
            {PROVIDER_CONFIG[provider].label}
          </Button>
        ))}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <p className="text-xs text-muted-foreground px-2 py-1">
              More providers coming soon
            </p>
          </PopoverContent>
        </Popover>
      </ButtonGroup>

      <ConnectionBaseUrlSelect
        value={connectionUrl}
        onChange={setConnectionUrl}
        idPrefix="llm"
      />

      {"isCommand" in providerConfig ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Run Claude Code with the Archestra proxy:
          </p>
          <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
            <CodeText className="text-xs text-primary flex-1">
              {claudeCodeCommand}
            </CodeText>
            <CopyButton
              textToCopy={claudeCodeCommand}
              toastMessage="Command copied to clipboard"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Replace your {providerConfig.label} base URL:
          </p>
          <UrlReplacementRow
            originalUrl={providerConfig.originalUrl}
            newUrl={proxyUrl}
          />
        </div>
      )}
    </div>
  );
}

function CopyButton({
  textToCopy,
  toastMessage,
}: {
  textToCopy: string;
  toastMessage: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success(toastMessage);
    setTimeout(() => setCopied(false), 2000);
  }, [textToCopy, toastMessage]);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-shrink-0"
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

function UrlReplacementRow({
  originalUrl,
  newUrl,
}: {
  originalUrl: string;
  newUrl: string;
}) {
  if (!newUrl) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 shrink-0">
        <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
          {originalUrl}
        </CodeText>
      </div>
      <span className="text-muted-foreground flex-shrink-0">→</span>
      <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
        <CodeText className="text-xs text-primary flex-1 break-all">
          {newUrl}
        </CodeText>
        <CopyButton
          textToCopy={newUrl}
          toastMessage="Proxy URL copied to clipboard"
        />
      </div>
    </div>
  );
}
