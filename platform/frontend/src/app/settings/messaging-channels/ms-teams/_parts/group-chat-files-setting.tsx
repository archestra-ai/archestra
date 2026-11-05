"use client";

import { Check, ChevronRight, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useChatOpsStatus } from "@/lib/chatops/chatops.query";
import {
  useMsTeamsChatOpsConfig,
  useUpdateMsTeamsGroupChatFileSignIn,
} from "@/lib/chatops/chatops-config.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils/tailwind";

/**
 * The group-chat file sign-in switch, inside the "Setup MS Teams" card. It
 * saves as soon as it flips. The Entra setup it depends on sits in a
 * collapsible below it, with a request the admin can hand to IT.
 */
export function GroupChatFilesSetting() {
  const appName = useAppName();
  const { data } = useMsTeamsChatOpsConfig();
  const { data: providers } = useChatOpsStatus();
  const mutation = useUpdateMsTeamsGroupChatFileSignIn();
  const on = mutation.isPending
    ? (mutation.variables ?? false)
    : (data?.groupChatFileSignIn ?? false);
  const appId =
    data?.appId ??
    providers?.find((p) => p.id === "ms-teams")?.dmInfo?.appId ??
    "";

  return (
    <div className="mt-3 flex flex-col gap-1 border-t pt-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Label
            htmlFor="ms-teams-group-chat-files"
            className="text-xs font-medium text-foreground"
          >
            Group-chat files
          </Label>
          <span>
            Each sender signs in once so the {appName} bot can read the files
            they share in group chats.
          </span>
        </div>
        <Switch
          id="ms-teams-group-chat-files"
          checked={on}
          disabled={mutation.isPending || !data}
          onCheckedChange={(checked) => mutation.mutate(checked)}
        />
      </div>

      <EntraSetup
        appId={appId}
        appName={appName}
        redirectUri={data?.signInRedirectUri ?? ""}
      />
    </div>
  );
}

// ===

function EntraSetup({
  appId,
  appName,
  redirectUri,
}: {
  appId: string;
  appName: string;
  redirectUri: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyToClipboard(
      buildGroupChatFilesRequest({ appId, appName, redirectUri }),
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="-ml-1.5 text-muted-foreground"
        >
          <ChevronRight
            className={cn("transition-transform", open && "rotate-90")}
          />
          <span>Microsoft Entra setup</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-col gap-2.5 rounded-md border bg-muted/40 px-3 py-2.5">
        <span>On the bot's app registration:</span>
        <ol className="flex flex-col gap-1.5">
          <li className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="tabular-nums">1.</span>
            <span>
              <span className="text-foreground">Authentication</span>: add a Web
              redirect URI
            </span>
            <span className="flex min-w-0 items-center gap-0.5">
              <code className="min-w-0 break-all rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">
                {redirectUri}
              </code>
              <CopyButton text={redirectUri} />
            </span>
          </li>
          <li className="flex gap-x-1.5">
            <span className="tabular-nums">2.</span>
            <span>
              <span className="text-foreground">API permissions</span>: add
              Microsoft Graph delegated{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                Files.Read
              </code>{" "}
              and{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                offline_access
              </code>
              , then grant admin consent.
            </span>
          </li>
        </ol>
        <div className="flex items-center justify-between gap-3 border-t pt-2.5">
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={handleCopy}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? <span>Copied</span> : <span>Copy request for IT</span>}
          </Button>
          <a
            href="https://entra.microsoft.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-1 hover:text-foreground hover:underline"
          >
            <span>Open Entra</span>
            <ExternalLink className="size-3" />
          </a>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function buildGroupChatFilesRequest(params: {
  appId: string;
  appName: string;
  redirectUri: string;
}): string {
  const appId = params.appId || "<Microsoft App ID>";
  return [
    `Sign-in for our Teams bot to read files shared in group chats`,
    ``,
    `Our ${params.appName} Teams bot (Microsoft App ID ${appId}) needs to read files people share in Teams group chats. Each sender signs in once, and the bot reads the file with that person's own access.`,
    ``,
    `Microsoft Entra admin center (https://entra.microsoft.com/) > App registrations > open the app by its App ID:`,
    ``,
    `1. Authentication > Add a platform > Web, with this redirect URI:`,
    `   ${params.redirectUri}`,
    ``,
    `2. API permissions > Add a permission > Microsoft Graph > Delegated permissions > add Files.Read and offline_access > Grant admin consent.`,
  ].join("\n");
}
