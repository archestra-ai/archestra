"use client";

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
import type { SupportedProviders } from "@/lib/clients/api/types.gen";
import config from "@/lib/config";

const { proxyUrl: apiProxyUrl } = config.api;

interface ProxyConnectionInstructionsProps {
  agentId?: string;
}

export function ProxyConnectionInstructions({
  agentId,
}: ProxyConnectionInstructionsProps) {
  const [copied, setCopied] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<SupportedProviders>("openai");

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
            setSelectedProvider(value as SupportedProviders)
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
      <div className="bg-muted rounded-md p-3 flex items-center justify-between">
        <CodeText className="text-sm">{proxyUrl}</CodeText>
        <Button variant="ghost" size="icon" onClick={handleCopy}>
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      {selectedProvider === "openai" && (
        <>
          <p className="text-sm text-muted-foreground">
            OpenAI provides{" "}
            <CodeText className="text-xs">/chat/completions</CodeText> and{" "}
            <CodeText className="text-xs">/responses</CodeText> API's. Archestra
            doesn't support <CodeText className="text-xs">/responses</CodeText>{" "}
            yet.
          </p>
          <p className="text-sm text-muted-foreground">
            We're working on it (
            <a
              href="https://github.com/archestra-ai/archestra/issues/720"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500"
            >
              GitHub issue
            </a>
            ), meanwhile please make sure that your agent uses{" "}
            <CodeText className="text-xs">/chat/completions</CodeText>, check{" "}
            <a
              href="https://ai-sdk.dev/providers/ai-sdk-providers/openai#language-models"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500"
            >
              this
            </a>{" "}
            for an example
          </p>
        </>
      )}
      {selectedProvider === "gemini" && (
        <>
          <p className="text-sm text-muted-foreground">
            Configure your agents to use this endpoint instead of directly
            calling Google Gemini (default should be
            https://generativelanguage.googleapis.com/v1/)
          </p>
          <p className="text-sm text-muted-foreground">
            Archestra supports{" "}
            <a
              href="https://ai.google.dev/api/generate-content"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500"
            >
              Gemini generateContent API
            </a>{" "}
            so make sure to use it when connecting to Archestra.
          </p>
        </>
      )}
      {selectedProvider === "anthropic" && (
        <>
          <p className="text-sm text-muted-foreground">
            Configure your agents to use this endpoint instead of directly
            calling Anthropic (default should be https://api.anthropic.com/v1/)
          </p>
          <p className="text-sm text-muted-foreground">
            Archestra supports{" "}
            <a
              href="https://docs.anthropic.com/en/api/messages"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500"
            >
              Anthropic messages API
            </a>{" "}
            so make sure to use it when connecting to Archestra.
          </p>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        The host/port is configurable via the{" "}
        <CodeText className="text-xs">ARCHESTRA_API_BASE_URL</CodeText>{" "}
        environment variable. See{" "}
        <a
          href="https://www.archestra.ai/docs/platform-deployment#environment-variables"
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
