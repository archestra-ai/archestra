"use client";

import type { SupportedProvider } from "@shared";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import config from "@/lib/config";

const { internalProxyUrl } = config.api;

type ProviderOption = SupportedProvider | "claude-code";

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderOption>("openai");

  const getProviderPath = (provider: ProviderOption) =>
    provider === "claude-code" ? "anthropic" : provider;

  const proxyUrl = agentId
    ? `${internalProxyUrl}/${getProviderPath(selectedProvider)}/${agentId}`
    : `${internalProxyUrl}/${getProviderPath(selectedProvider)}`;

  const claudeCodeCommand = `ANTHROPIC_BASE_URL=${internalProxyUrl}/anthropic${agentId ? `/${agentId}` : ""} claude`;

  return (
    <div className="space-y-3">
      <ButtonGroup>
        <Button
          variant={selectedProvider === "openai" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedProvider("openai")}
        >
          OpenAI
        </Button>
        <Button
          variant={selectedProvider === "gemini" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedProvider("gemini")}
        >
          Gemini
        </Button>
        <Button
          variant={selectedProvider === "anthropic" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedProvider("anthropic")}
        >
          Anthropic
        </Button>
        <Button
          variant={selectedProvider === "cerebras" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedProvider("cerebras")}
        >
          Cerebras
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant={
                selectedProvider === "claude-code" ? "default" : "outline"
              }
              size="sm"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => setSelectedProvider("claude-code")}
            >
              Claude Code
            </Button>
            <p className="text-xs text-muted-foreground px-2 py-1">
              More providers coming soon
            </p>
          </PopoverContent>
        </Popover>
      </ButtonGroup>

      {selectedProvider === "openai" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Replace your OpenAI base URL:
          </p>
          <UrlReplacementRow
            originalUrl="https://api.openai.com/v1/"
            newUrl={proxyUrl}
          />
        </div>
      )}
      {selectedProvider === "gemini" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Replace your Gemini base URL:
          </p>
          <UrlReplacementRow
            originalUrl="https://generativelanguage.googleapis.com/v1/"
            newUrl={proxyUrl}
          />
        </div>
      )}
      {selectedProvider === "anthropic" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Replace your Anthropic base URL:
          </p>
          <UrlReplacementRow
            originalUrl="https://api.anthropic.com/v1/"
            newUrl={proxyUrl}
          />
        </div>
      )}
      {selectedProvider === "cerebras" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Replace your Cerebras base URL:
          </p>
          <UrlReplacementRow
            originalUrl="https://api.cerebras.ai/v1/"
            newUrl={proxyUrl}
          />
        </div>
      )}
      {selectedProvider === "claude-code" && (
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
        <CodeText className="text-xs text-primary whitespace-nowrap">
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
