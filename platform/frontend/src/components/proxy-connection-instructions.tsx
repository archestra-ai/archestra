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

const { displayProxyUrl: apiProxyUrl } = config.api;

type ProviderOption = SupportedProvider | "claude-code";

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<ProviderOption>("openai");

  const proxyUrl = agentId
    ? `${apiProxyUrl}/${selectedProvider === "claude-code" ? "anthropic" : selectedProvider}/${agentId}`
    : `${apiProxyUrl}/${selectedProvider === "claude-code" ? "anthropic" : selectedProvider}`;

  const claudeCodeCommand = `ANTHROPIC_BASE_URL=${apiProxyUrl}/anthropic${agentId ? `/${agentId}` : ""} claude`;

  const handleCopy = useCallback(async () => {
    const textToCopy =
      selectedProvider === "claude-code" ? claudeCodeCommand : proxyUrl;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success(
      selectedProvider === "claude-code"
        ? "Command copied to clipboard"
        : "Proxy URL copied to clipboard",
    );
    setTimeout(() => setCopied(false), 2000);
  }, [proxyUrl, claudeCodeCommand, selectedProvider]);

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
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Replace your OpenAI base URL:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 shrink-0">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://api.openai.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary whitespace-nowrap">
                {proxyUrl}
              </CodeText>
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
            </div>
          </div>
        </div>
      )}
      {selectedProvider === "gemini" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Replace your Gemini base URL:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 shrink-0">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://generativelanguage.googleapis.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary whitespace-nowrap">
                {proxyUrl}
              </CodeText>
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
            </div>
          </div>
        </div>
      )}
      {selectedProvider === "anthropic" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Replace your Anthropic base URL:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 shrink-0">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://api.anthropic.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary whitespace-nowrap">
                {proxyUrl}
              </CodeText>
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
            </div>
          </div>
        </div>
      )}
      {selectedProvider === "cerebras" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Replace your Cerebras base URL:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30 shrink-0">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://api.cerebras.ai/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary whitespace-nowrap">
                {proxyUrl}
              </CodeText>
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
            </div>
          </div>
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
          </div>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        The URL is configurable via the{" "}
        <CodeText className="text-xs">ARCHESTRA_API_EXTERNAL_BASE_URL</CodeText>{" "}
        environment variable. See{" "}
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
