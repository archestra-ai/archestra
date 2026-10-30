"use client";

import { Download, ExternalLink, Info, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDownloadChatgptPlugin } from "./chatgpt-plugin.query";

export function ChatgptGatewaySetup({
  gateway,
  baseUrl,
  includeSkills = false,
}: {
  gateway: {
    id: string;
    slug?: string | null;
    name: string;
    isPersonalGateway?: boolean;
  } | null;
  baseUrl: string;
  includeSkills?: boolean;
}) {
  const appName = useAppName();
  const { data: canReadSkills } = useHasPermissions({ skill: ["read"] });
  const configuredUrl = gateway
    ? `${baseUrl}/mcp/${gateway.slug ?? gateway.id}`
    : "";
  const [gatewayUrl, setGatewayUrl] = useState(configuredUrl);
  useEffect(() => setGatewayUrl(configuredUrl), [configuredUrl]);
  const download = useDownloadChatgptPlugin();
  const withSkills = includeSkills && canReadSkills === true;
  return (
    <div className="space-y-4">
      {gateway ? (
        <>
          <p className="text-sm text-muted-foreground">
            Download your {appName} plugin, then choose{" "}
            <strong>Upload plugin archive</strong> in ChatGPT Plugins and
            connect your account.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={download.isPending}
              onClick={() =>
                download.mutate({
                  appName,
                  gatewayUrl,
                  includeSkills: withSkills,
                })
              }
            >
              {download.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Download />
              )}
              <span>
                {download.isPending
                  ? "Preparing plugin"
                  : "Download ChatGPT plugin"}
              </span>
            </Button>
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
          </div>
          <p className="text-xs text-muted-foreground">
            {withSkills
              ? "Includes MCP tools and copies of your accessible portable skills. Download again to update skills."
              : "Includes your MCP gateway. Skills are excluded from this download."}
          </p>
          {download.data && download.data.omitted.length > 0 && (
            <InlineNotice variant="info">
              <Info />
              <span className="font-medium">
                Some skills need platform activation
              </span>
              <InlineNoticeText>
                {download.data.omitted.join(", ")}
              </InlineNoticeText>
            </InlineNotice>
          )}
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost">
                Connection options and model routing
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <Label htmlFor="chatgpt-gateway-url">Gateway HTTPS URL</Label>
              <Input
                id="chatgpt-gateway-url"
                value={gatewayUrl}
                onChange={(e) => setGatewayUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                ChatGPT must reach this endpoint. Private deployments need a
                separately configured Secure MCP Tunnel. Workspace policy may
                restrict archive uploads or custom MCP servers. OAuth approval
                stays in ChatGPT; OAuth credentials are not added to the
                archive.
              </p>
              <p className="text-xs text-muted-foreground">
                Plugin archives do not configure inference. Local Work supports
                separate native model-gateway configuration; cloud chats and
                dots do not inherit that local setting.
              </p>
              <a
                className="text-xs underline underline-offset-4"
                href="https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway"
                target="_blank"
                rel="noopener noreferrer"
              >
                Local Work model-gateway setup
              </a>
            </CollapsibleContent>
          </Collapsible>
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
