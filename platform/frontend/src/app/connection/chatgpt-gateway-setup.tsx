"use client";

import { Download, ExternalLink, Info, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { UnstyledButton } from "@/components/ui/unstyled-button";
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
  const gatewayUrl = gateway
    ? `${baseUrl}/mcp/${gateway.slug ?? gateway.id}`
    : "";
  const download = useDownloadChatgptPlugin();
  const withSkills = includeSkills && canReadSkills === true;
  const [downloadedFor, setDownloadedFor] = useState<string | null>(null);
  const selection = JSON.stringify([appName, gatewayUrl, withSkills]);
  const downloaded = downloadedFor === selection;
  return (
    <div className="space-y-4">
      {gateway ? (
        <>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <p className="text-sm text-muted-foreground">
              {downloaded ? (
                <span>
                  Your plugin is ready. Open ChatGPT, then choose{" "}
                  <strong>Upload plugin archive</strong> and connect your
                  account.
                </span>
              ) : (
                <span>Download your {appName} plugin to get started.</span>
              )}
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              {downloaded ? (
                <>
                  <Button asChild size="sm" variant="outline">
                    <a href="codex://plugins">
                      <ExternalLink />
                      <span>Open ChatGPT</span>
                    </a>
                  </Button>
                  <a
                    className="text-[11px] text-muted-foreground underline underline-offset-4"
                    href="https://chatgpt.com/plugins"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Configure on web instead
                  </a>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={download.isPending}
                  onClick={() =>
                    download.mutate(
                      { appName, gatewayUrl, includeSkills: withSkills },
                      { onSuccess: () => setDownloadedFor(selection) },
                    )
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
              )}
            </div>
          </div>
          {downloaded && (
            <UnstyledButton
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-4"
              onClick={() => {
                setDownloadedFor(null);
                download.reset();
              }}
            >
              Download plugin again
            </UnstyledButton>
          )}
          {downloaded && download.data && download.data.omitted.length > 0 && (
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
