"use client";

import { Check, Download, ExternalLink, Info, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
          <ol aria-label="ChatGPT setup" className="text-sm">
            <li
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 border-b pb-4"
              aria-current={downloaded ? undefined : "step"}
            >
              <div
                aria-hidden="true"
                className={`flex size-5 items-center justify-center rounded-full ${downloaded ? "bg-primary/10 text-primary" : "border text-muted-foreground"}`}
              >
                {downloaded ? (
                  <Check className="size-3.5" />
                ) : download.isPending ? (
                  <Loader2 className="size-3.5 motion-safe:animate-spin" />
                ) : (
                  <span className="text-xs">1</span>
                )}
              </div>
              <p aria-live="polite" className="min-w-0 font-medium">
                <span>
                  {downloaded ? "Plugin downloaded" : "Download plugin"}
                </span>
              </p>
              <div
                className={
                  downloaded
                    ? "col-start-3"
                    : "col-span-2 col-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1"
                }
              >
                {downloaded ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label="Download plugin again"
                    title="Download again"
                    onClick={() => {
                      setDownloadedFor(null);
                      download.reset();
                    }}
                  >
                    <Download aria-hidden="true" />
                    <span className="hidden sm:inline">Download again</span>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="w-full sm:w-auto"
                    aria-label={
                      download.isPending
                        ? "Preparing plugin"
                        : "Download ChatGPT plugin"
                    }
                    disabled={download.isPending}
                    onClick={() =>
                      download.mutate(
                        { appName, gatewayUrl, includeSkills: withSkills },
                        { onSuccess: () => setDownloadedFor(selection) },
                      )
                    }
                  >
                    {download.isPending ? (
                      <Loader2
                        className="motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Download aria-hidden="true" />
                    )}
                    {download.isPending ? (
                      <span>Preparing plugin</span>
                    ) : (
                      <>
                        <span className="sm:hidden">Download plugin</span>
                        <span className="hidden sm:inline">
                          Download ChatGPT plugin
                        </span>
                      </>
                    )}
                  </Button>
                )}
              </div>
            </li>
            <li
              className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-3 pt-4 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto]"
              aria-current={downloaded ? "step" : undefined}
            >
              <div
                aria-hidden="true"
                className={`flex size-5 items-center justify-center rounded-full ${downloaded ? "bg-primary text-primary-foreground" : "border text-muted-foreground"}`}
              >
                <span className="text-xs">2</span>
              </div>
              <div className="min-w-0 space-y-1">
                <p
                  className={`font-medium ${downloaded ? "text-foreground" : "text-muted-foreground"}`}
                >
                  Open ChatGPT
                </p>
                <p
                  aria-live="polite"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {downloaded ? (
                    <span>
                      Choose <strong>Upload plugin archive</strong> in Plugins,
                      then connect your account.
                    </span>
                  ) : (
                    <span>Save your plugin archive to continue.</span>
                  )}
                </p>
              </div>
              {downloaded && (
                <div className="col-start-2 flex flex-col items-start gap-2 sm:col-start-3 sm:row-start-1 sm:row-span-2">
                  <Button asChild size="sm">
                    <a href="codex://plugins">
                      <ExternalLink aria-hidden="true" />
                      <span>Open ChatGPT</span>
                    </a>
                  </Button>
                  <a
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                    href="https://chatgpt.com/plugins"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Configure on web instead
                  </a>
                </div>
              )}
            </li>
          </ol>
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
