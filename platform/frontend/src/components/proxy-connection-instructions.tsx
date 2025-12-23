"use client";

import type { SupportedProvider } from "@shared";
import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { CodeText } from "@/components/code-text";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import config from "@/lib/config";

const { displayProxyUrl: apiProxyUrl } = config.api;

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<SupportedProvider>("openai");

  const proxyUrl = agentId
    ? `${apiProxyUrl}/${selectedProvider}/${agentId}`
    : `${apiProxyUrl}/${selectedProvider}`;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(proxyUrl);
    setCopied(true);
    toast.success("Proxy URL copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }, [proxyUrl]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Provider:</span>
        <Select
          value={selectedProvider}
          onValueChange={(value) =>
            setSelectedProvider(value as SupportedProvider)
          }
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="openai">OpenAI</SelectItem>
            {/* TODO: uncomment out once we officially have 100% support for Gemini */}
            {/* <SelectItem value="gemini">Gemini</SelectItem> */}
            <SelectItem value="anthropic">Anthropic</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selectedProvider === "openai" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Replace your OpenAI base URL:
          </p>
          <div className="flex items-center gap-2">
            <div className="min-w-0 bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://api.openai.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="flex-1 min-w-0 bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary break-all flex-1">
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
          <div className="flex items-center gap-2">
            <div className="min-w-0 bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://generativelanguage.googleapis.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="flex-1 min-w-0 bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary break-all flex-1">
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
          <div className="flex items-center gap-2">
            <div className="min-w-0 bg-muted/50 rounded-md px-3 py-2 border border-dashed border-muted-foreground/30">
              <CodeText className="text-xs line-through opacity-50 whitespace-nowrap">
                https://api.anthropic.com/v1/
              </CodeText>
            </div>
            <span className="text-muted-foreground flex-shrink-0">→</span>
            <div className="flex-1 min-w-0 bg-primary/5 rounded-md px-3 py-2 border border-primary/20 flex items-center gap-2">
              <CodeText className="text-xs text-primary break-all flex-1">
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
      <p className="text-sm text-muted-foreground">
        The host/port is configurable via the{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText>{" "}
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
