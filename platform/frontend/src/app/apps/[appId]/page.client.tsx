"use client";

import Link from "next/link";
import { AppFrame } from "@/components/mcp-app/app-frame";
import { McpAppStandaloneButton } from "@/components/mcp-app/mcp-app-chrome";
import { useApp } from "@/lib/app.query";
import { useSession } from "@/lib/auth/auth.query";
import { AppChatButton } from "../_parts/app-chat-button";
import { AppConnectButton } from "../_parts/app-connect-button";
import { AppMeta, AppTitle } from "../_parts/app-header";
import { AppModelPanel } from "../_parts/app-model-panel";
import { AppVersionHistory } from "../_parts/app-version-history";

export default function AppDetailPage({ appId }: { appId: string }) {
  const { data: app, isPending } = useApp(appId);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  return (
    <div className="flex h-full w-full flex-col">
      <header className="flex items-start shrink-0 border-b px-6 py-2">
        <Link
          href="/apps"
          className="inline-flex items-center gap-2 tracking-tight text-muted-foreground hover:underline"
        >
          Apps
        </Link>
      </header>

      <div className="mx-auto w-full max-w-[1680px] space-y-16 px-6 pb-6 pt-10">
        {!isPending && !app ? (
          <p className="text-sm text-muted-foreground">
            This app does not exist or you do not have access to it.
          </p>
        ) : app ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <AppTitle app={app} currentUserId={currentUserId} />
                <p className="text-sm text-muted-foreground">
                  <AppMeta app={app} currentUserId={currentUserId} />
                </p>
              </div>
              <div className="flex items-center gap-2">
                <AppChatButton app={app} />
                <AppConnectButton app={app} />
              </div>
            </div>

            <div className="flex flex-col gap-20">
              <section className="grid gap-10 lg:grid-cols-2 lg:gap-x-20">
                <div className="space-y-3">
                  <h2 className="text-lg font-semibold">Preview</h2>
                  <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-lg border">
                    <AppFrame
                      endpoint={{ kind: "app", appId }}
                      fillContainer
                      actions={<McpAppStandaloneButton appId={appId} />}
                    />
                  </div>
                </div>
                <div className="space-y-12">
                  <div className="space-y-4">
                    <div className="space-y-1">
                      <h2 className="text-lg font-semibold">Model context</h2>
                      <p className="max-w-xs text-sm text-muted-foreground">
                        What the model reads to decide whether this
                        app&nbsp;is&nbsp;relevant and when to open it.
                      </p>
                    </div>
                    <AppModelPanel app={app} />
                  </div>
                </div>
              </section>

              <AppVersionHistory appId={appId} />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
