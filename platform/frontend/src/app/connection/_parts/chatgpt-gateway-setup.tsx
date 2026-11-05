"use client";

import { Download, ExternalLink, Info, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDownloadChatgptPlugin } from "./chatgpt-plugin.query";
import {
  OneOf,
  SetupActionArea,
  SetupActionRow,
  SetupNextSteps,
} from "./connect-page-parts";

export function ChatgptGatewaySetup({
  gateway,
  baseUrl,
  includeSkills = false,
  sizingCommand = "",
  disabled = false,
  showTerminal = false,
  terminalAction,
  terminalNextSteps,
}: {
  gateway: {
    id: string;
    slug?: string | null;
    name: string;
    isPersonalGateway?: boolean;
  } | null;
  baseUrl: string;
  includeSkills?: boolean;
  sizingCommand?: string;
  disabled?: boolean;
  showTerminal?: boolean;
  terminalAction?: ReactNode;
  terminalNextSteps?: ReactNode;
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
  const webAction = gateway ? (
    <SetupActionRow>
      <Download className="size-4 shrink-0 text-muted-foreground" />
      <span
        aria-live="polite"
        className="min-w-0 flex-1 text-sm text-muted-foreground"
      >
        {download.isPending
          ? "Preparing your plugin"
          : downloaded
            ? "Downloaded. Upload the .ZIP file in ChatGPT Plugins."
            : `Download the ${appName} plugin for this setup`}
      </span>
      <Button
        size="lg"
        className="rounded-xl"
        aria-label={
          download.isPending
            ? "Preparing plugin"
            : downloaded
              ? "Download plugin again"
              : "Download ChatGPT plugin"
        }
        disabled={disabled || download.isPending}
        onClick={() =>
          download.mutate(
            { appName, gatewayUrl, includeSkills: withSkills },
            { onSuccess: () => setDownloadedFor(selection) },
          )
        }
      >
        {download.isPending ? (
          <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <Download aria-hidden="true" />
        )}
        <span>
          {download.isPending
            ? "Preparing plugin"
            : downloaded
              ? "Download again"
              : "Download plugin"}
        </span>
      </Button>
    </SetupActionRow>
  ) : (
    <InlineNotice>
      <Info />
      <span className="font-medium">No MCP gateway available</span>
      <InlineNoticeText>
        Ask your administrator for access to an MCP gateway before connecting
        ChatGPT.
      </InlineNoticeText>
    </InlineNotice>
  );
  return (
    <div>
      <SetupActionArea sizingCommand={sizingCommand}>
        <OneOf
          shown={showTerminal ? 0 : 1}
          className="[&>div]:grid [&>div]:grid-cols-[minmax(0,1fr)]"
        >
          {terminalAction}
          {webAction}
        </OneOf>
      </SetupActionArea>
      <OneOf shown={showTerminal ? 0 : 1}>
        {terminalNextSteps}
        {gateway ? (
          <>
            <SetupNextSteps>
              <ol
                aria-label="ChatGPT setup"
                className="mt-1 list-decimal space-y-0.5 pl-4"
              >
                <li>
                  In{" "}
                  <a
                    href="https://chatgpt.com/plugins"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-muted-foreground/40 underline-offset-4 hover:text-foreground"
                  >
                    ChatGPT Plugins
                    <ExternalLink aria-hidden className="ml-1 inline size-3" />
                  </a>
                  , choose <strong>Upload plugin archive</strong> and select the
                  .ZIP file.
                </li>
                <li>
                  Connect your account and approve gateway access in your
                  browser.
                </li>
                <li>
                  Start a web chat or dot and select the {appName} plugin.
                </li>
              </ol>
            </SetupNextSteps>
            {downloaded &&
              download.data &&
              download.data.omitted.length > 0 && (
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
            {downloaded &&
              download.data &&
              download.data.unportable.length > 0 && (
                <InlineNotice variant="info">
                  <Info />
                  <span className="font-medium">
                    Some skill names are not portable
                  </span>
                  <InlineNoticeText>
                    Rename these skills to include them. A name can have up to
                    64 lowercase letters and digits, with single hyphens between
                    words: {download.data.unportable.join(", ")}
                  </InlineNoticeText>
                </InlineNotice>
              )}
          </>
        ) : null}
      </OneOf>
    </div>
  );
}
