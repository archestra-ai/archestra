"use client";

import { ArrowLeft, Loader2, MessageSquare } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useExternalApp, useOpenExternalAppInChat } from "@/lib/app.query";
import { setPendingProjectChatHandoff } from "@/lib/chat/pending-project-chat-handoff";

type Install = {
  mcpServerId: string;
  scope: "personal" | "team" | "org";
  name: string;
};

const SCOPE_LABEL: Record<Install["scope"], string> = {
  personal: "Personal",
  team: "Team",
  org: "Organization",
};

// Full-page standalone runtime for an external UI-providing app, keyed by its
// catalog item. Lives under the chrome-less /a namespace alongside the owned
// standalone /a/[appId]. An external app runs server-scoped against one
// concrete install; the caller picks which (default personal → team → org),
// carried in `?install=` so a shared link reopens the sender's install
// (mcp-apps.md FR-31).
export default function CatalogAppRunPage({
  catalogId,
}: {
  catalogId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedInstall = searchParams.get("install");
  const requestedResource = searchParams.get("resource");
  const { data, isPending } = useExternalApp(catalogId);

  const installs = data?.installs ?? [];
  const activeInstallId =
    (requestedInstall &&
    installs.some((i) => i.mcpServerId === requestedInstall)
      ? requestedInstall
      : data?.defaultMcpServerId) ?? null;

  // A server may expose several UI resources; render the requested one, falling
  // back to the default (and its composed "<server> / <tool>" label for the header).
  const resources = data?.resources ?? [];
  const activeResource =
    resources.find((r) => r.resourceUri === requestedResource) ??
    resources.find((r) => r.resourceUri === data?.resourceUri) ??
    resources[0] ??
    null;

  // Standalone surface: the app name is the browser tab title, like /a/[appId].
  const title = activeResource?.name ?? data?.name;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  // A catalog the caller can see but has no accessible install for is listable
  // but not runnable: send them to install rather than render (FR-31).
  useEffect(() => {
    if (!isPending && data && !activeInstallId) {
      router.replace(`/mcp/registry?search=${encodeURIComponent(data.name)}`);
    }
  }, [isPending, data, activeInstallId, router]);

  if (!isPending && !data) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          This app does not exist or you do not have access to it.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back to Apps
          </Link>
        </Button>
      </div>
    );
  }

  const selectInstall = (mcpServerId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("install", mcpServerId);
    router.replace(`/a/catalog/${catalogId}?${params.toString()}`);
  };

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Button asChild variant="ghost" size="sm">
          <Link href="/apps">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">{title ?? "App"}</span>
        {installs.length > 1 && activeInstallId ? (
          <div className="ml-auto">
            <Select value={activeInstallId} onValueChange={selectInstall}>
              <SelectTrigger className="h-8 w-[240px]" aria-label="Run as">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {installs.map((install) => (
                  <SelectItem
                    key={install.mcpServerId}
                    value={install.mcpServerId}
                  >
                    {SCOPE_LABEL[install.scope]} · {install.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-auto">
        {data && activeInstallId && activeResource ? (
          activeResource.requiresInput ? (
            // The tool has required inputs, so rendering the resource bare
            // would mount a broken app; hand off to chat instead, where the
            // agent collects the inputs and the tool result mounts the app.
            <NeedsInputHandoff
              name={activeResource.name}
              mcpServerId={activeInstallId}
              resourceUri={activeResource.resourceUri}
            />
          ) : (
            <AppFrame
              endpoint={{ kind: "server", mcpServerId: activeInstallId }}
              resourceUri={activeResource.resourceUri}
            />
          )
        ) : null}
      </main>
    </div>
  );
}

// Mirrors the app card's prompt-mode open: create the conversation, stash the
// opening prompt in the pending-chat handoff, and navigate to /chat/<id>.
function NeedsInputHandoff({
  name,
  mcpServerId,
  resourceUri,
}: {
  name: string;
  mcpServerId: string;
  resourceUri: string;
}) {
  const router = useRouter();
  const openApp = useOpenExternalAppInChat();
  // Stays true through the redirect; only a failure resets it.
  const [isOpening, setIsOpening] = useState(false);

  const handleOpen = async () => {
    setIsOpening(true);
    const result = await openApp.mutateAsync({ mcpServerId, resourceUri });
    if (result?.conversationId) {
      if (result.mode === "prompt" && result.prompt) {
        setPendingProjectChatHandoff({
          conversationId: result.conversationId,
          prompt: result.prompt,
        });
      }
      router.push(`/chat/${result.conversationId}`);
    } else {
      setIsOpening(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="max-w-md text-sm text-muted-foreground">
        {name} needs a few inputs before it can render, so it can't run
        standalone. Open it in chat and the agent will ask for them.
      </p>
      <Button onClick={handleOpen} disabled={isOpening} size="sm">
        {isOpening ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <MessageSquare className="h-4 w-4" />
        )}
        Open in chat
      </Button>
    </div>
  );
}
