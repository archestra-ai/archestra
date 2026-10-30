"use client";

import { ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useAppName } from "@/lib/hooks/use-app-name";
import type { ConnectClient } from "./clients";
import { McpClientInstructions } from "./mcp-client-instructions";

export function ChatgptGatewaySetup({
  client,
  gateway,
  baseUrl,
}: {
  client: ConnectClient;
  gateway: {
    id: string;
    slug?: string | null;
    name: string;
    isPersonalGateway?: boolean;
  } | null;
  baseUrl: string;
}) {
  const appName = useAppName();
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Connect {appName}'s MCP tools in ChatGPT desktop, Chat and Work. This
        setup does not install shared skills or route model requests through the
        LLM proxy. The Codex installer configures Codex separately.
      </p>
      {gateway ? (
        <>
          <InlineNotice variant="info">
            <Info />
            <span className="font-medium">Check gateway reachability</span>
            <InlineNoticeText>
              ChatGPT needs a public HTTPS endpoint or Secure MCP Tunnel. A URL
              that works only on your computer or private network needs a tunnel
              configured separately.
            </InlineNoticeText>
          </InlineNotice>
          <Button asChild size="sm" variant="outline">
            <a
              href="https://chatgpt.com/plugins"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
              <span>Open ChatGPT Plugins</span>
            </a>
          </Button>
          <McpClientInstructions
            client={client}
            gatewaySlug={gateway.slug ?? gateway.id}
            gatewayName={gateway.name}
            isPersonalGateway={gateway.isPersonalGateway}
            baseUrl={baseUrl}
          />
          <a
            className="text-sm underline underline-offset-4"
            href="https://developers.openai.com/plugins/deploy/connect-chatgpt"
            target="_blank"
            rel="noopener noreferrer"
          >
            ChatGPT connection and troubleshooting guide
          </a>
        </>
      ) : (
        <InlineNotice>
          <Info />
          <span className="font-medium">No MCP gateway available</span>
          <InlineNoticeText>
            Ask your administrator for access to an MCP gateway before
            connecting ChatGPT.
          </InlineNoticeText>
        </InlineNotice>
      )}
    </div>
  );
}
