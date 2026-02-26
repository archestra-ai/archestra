"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { CodeText } from "@/components/code-text";
import { ConnectionBaseUrlSelect } from "@/components/connection-base-url-select";
import { CopyableCode } from "@/components/copyable-code";
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
  perplexity: {
    label: providerDisplayNames.perplexity,
    originalUrl: "https://api.perplexity.ai/",
  },
  groq: {
    label: providerDisplayNames.groq,
    originalUrl: "https://api.groq.com/openai/v1/",
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
  deepseek: {
    label: providerDisplayNames.deepseek,
    originalUrl: "https://api.deepseek.com/",
  },
  minimax: {
    label: providerDisplayNames.minimax,
    originalUrl: "https://api.minimax.io/v1/",
  },
  bedrock: {
    label: providerDisplayNames.bedrock,
    originalUrl: "https://bedrock-runtime.your-region.amazonaws.com/",
  },
  "claude-code": { label: "Claude Code", isCommand: true },
};

/** Featured providers to show as primary buttons */
const PRIMARY_PROVIDERS: ProviderOption[] = [
  "openai",
  "anthropic",
  "gemini",
  "bedrock",
  "claude-code",
];

/** All other providers to show in the overflow dropdown */
const DROPDOWN_PROVIDERS: ProviderOption[] = (
  Object.keys(PROVIDER_CONFIG) as ProviderOption[]
).filter((provider) => !PRIMARY_PROVIDERS.includes(provider));

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
  const [popoverOpen, setPopoverOpen] = useState(false);

  const getProviderPath = (provider: ProviderOption) =>
    provider === "claude-code" ? "anthropic" : provider;

  const proxyUrl = agentId
    ? `${connectionUrl}/${getProviderPath(selectedProvider)}/${agentId}`
    : `${connectionUrl}/${getProviderPath(selectedProvider)}`;

  const claudeCodeCommand = `ANTHROPIC_BASE_URL=${connectionUrl}/anthropic${agentId ? `/${agentId}` : ""} claude`;

  const providerConfig = PROVIDER_CONFIG[selectedProvider];

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto -mx-1 px-1">
        <ButtonGroup className="flex-wrap">
          {PRIMARY_PROVIDERS.map((provider) => (
            <Button
              key={provider}
              variant={selectedProvider === provider ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedProvider(provider)}
            >
              {PROVIDER_CONFIG[provider].label}
            </Button>
          ))}
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant={
                  DROPDOWN_PROVIDERS.includes(selectedProvider)
                    ? "default"
                    : "outline"
                }
                size="sm"
                aria-label="More providers"
              >
                {DROPDOWN_PROVIDERS.includes(selectedProvider)
                  ? PROVIDER_CONFIG[selectedProvider].label
                  : null}
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto p-1 flex flex-col"
              aria-label="Additional providers"
            >
              {DROPDOWN_PROVIDERS.map((provider) => (
                <Button
                  key={provider}
                  variant={selectedProvider === provider ? "default" : "ghost"}
                  size="sm"
                  className="justify-start"
                  onClick={() => {
                    setSelectedProvider(provider);
                    setPopoverOpen(false);
                  }}
                >
                  {PROVIDER_CONFIG[provider].label}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </ButtonGroup>
      </div>

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
          <CopyableCode
            value={claudeCodeCommand}
            toastMessage="Command copied to clipboard"
            variant="primary"
          >
            <CodeText className="text-xs text-primary break-all">
              {claudeCodeCommand}
            </CodeText>
          </CopyableCode>
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

      <div className="mt-4 space-y-1">
        <p className="text-sm text-muted-foreground">
          <a
            href="/llm-proxies/provider-settings?tab=virtual-keys"
            className="underline hover:text-foreground"
          >
            Virtual API Keys
          </a>{" "}
          — generate keys for external clients without exposing real provider
          keys
        </p>
        <p className="text-sm text-muted-foreground">
          <a
            href="https://archestra.ai/docs/platform-llm-proxy-authentication#jwks-external-identity-provider"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            JWKS Authentication
          </a>{" "}
          — authenticate with an external identity provider
        </p>
      </div>
    </div>
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
    <div className="flex flex-col md:flex-row md:flex-wrap items-stretch md:items-center gap-2 min-w-0">
      <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 min-w-0 max-w-full overflow-hidden">
        <CodeText className="text-xs line-through opacity-50 break-all">
          {originalUrl}
        </CodeText>
      </div>
      <span className="text-muted-foreground flex-shrink-0 text-center md:text-left">
        →
      </span>
      <CopyableCode
        value={newUrl}
        toastMessage="Proxy URL copied to clipboard"
        variant="primary"
        className="flex-1 min-w-0 max-w-full overflow-hidden"
      >
        <CodeText className="text-xs text-primary break-all min-w-0">
          {newUrl}
        </CodeText>
      </CopyableCode>
    </div>
  );
}
