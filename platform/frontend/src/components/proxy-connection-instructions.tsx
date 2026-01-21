"use client";

import type { SupportedProvider } from "@shared";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import config from "@/lib/config";
import { cn } from "@/lib/utils";

const { externalProxyUrl, internalProxyUrl } = config.api;

type ProviderOption = SupportedProvider | "claude-code";
type ConnectionType = "internal" | "external";

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderOption>("openai");
  const [connectionType, setConnectionType] =
    useState<ConnectionType>("external");

  const getProviderPath = (provider: ProviderOption) =>
    provider === "claude-code" ? "anthropic" : provider;

  const baseUrl =
    connectionType === "internal" ? internalProxyUrl : externalProxyUrl;

  const proxyUrl = agentId
    ? `${baseUrl}/${getProviderPath(selectedProvider)}/${agentId}`
    : `${baseUrl}/${getProviderPath(selectedProvider)}`;

  const claudeCodeCommand = `ANTHROPIC_BASE_URL=${baseUrl}/anthropic${agentId ? `/${agentId}` : ""} claude`;

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

      {/* Connection Type Selector */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Connection type</Label>
        <RadioGroup
          value={connectionType}
          onValueChange={(value) => setConnectionType(value as ConnectionType)}
          className="flex flex-col gap-3"
        >
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value="internal"
              id="llm-internal"
              className="mt-0.5"
            />
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="llm-internal"
                className="font-normal cursor-pointer"
              >
                Via Internal URL
              </Label>
              <span className="text-xs text-muted-foreground">
                Internal URL for in-cluster communication. This is the URL where
                the frontend connects to the backend API server.
              </span>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <RadioGroupItem
              value="external"
              id="llm-external"
              className="mt-0.5"
              disabled={!externalProxyUrl}
            />
            <div className="flex flex-col gap-0.5">
              <Label
                htmlFor="llm-external"
                className={cn(
                  "font-normal cursor-pointer",
                  !externalProxyUrl && "opacity-50",
                )}
              >
                Via External URL
              </Label>
              <span className="text-xs text-muted-foreground">
                External URL for connecting to LLM Gateway from outside the
                Kubernetes cluster.
              </span>
            </div>
          </div>
        </RadioGroup>
      </div>

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

      <p className="text-sm text-muted-foreground">
        The URLs are configurable via{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText> and{" "}
        <CodeText className="text-xs">ARCHESTRA_API_EXTERNAL_BASE_URL</CodeText>{" "}
        environment variables. See{" "}
        <a
          href="https://archestra.ai/docs/platform-deployment#environment-variables"
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-500"
        >
          here
        </a>{" "}
        for more details.
      </p>
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
