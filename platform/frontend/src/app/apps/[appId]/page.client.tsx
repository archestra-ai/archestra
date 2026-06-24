"use client";

import { AppFrame } from "@/components/mcp-app/app-frame";
import { McpAppStandaloneButton } from "@/components/mcp-app/mcp-app-chrome";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApp } from "@/lib/app.query";
import { useSession } from "@/lib/auth/auth.query";
import { AppSettingsForm } from "../_parts/app-settings-form";
import { AppShareTab } from "../_parts/app-share-tab";
import { AppToolsTab } from "../_parts/app-tools-tab";
import { AppVersionsTab } from "../_parts/app-versions-tab";

export default function AppDetailPage({ appId }: { appId: string }) {
  const { data: app, isPending } = useApp(appId);
  const { data: session } = useSession();

  if (!isPending && !app) {
    return (
      <PageLayout title="App not found" description="">
        <p className="text-sm text-muted-foreground">
          This app does not exist or you do not have access to it.
        </p>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title={
        <span className="flex items-center gap-2">
          {app?.name ?? "App"}
          {app ? (
            <ResourceVisibilityBadge
              scope={app.scope}
              teams={undefined}
              authorId={app.authorId}
              authorName={undefined}
              currentUserId={session?.user?.id}
            />
          ) : null}
        </span>
      }
      description={app?.description ?? ""}
    >
      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="share">Share</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="preview">
          <div className="h-[70vh] min-h-[400px] overflow-hidden rounded-lg border">
            <AppFrame
              endpoint={{ kind: "app", appId }}
              fillContainer
              actions={<McpAppStandaloneButton appId={appId} />}
            />
          </div>
        </TabsContent>

        <TabsContent value="tools">
          <AppToolsTab appId={appId} />
        </TabsContent>

        <TabsContent value="share">
          <AppShareTab appId={appId} />
        </TabsContent>

        <TabsContent value="versions">
          <AppVersionsTab appId={appId} />
        </TabsContent>

        <TabsContent value="settings">
          {app ? <AppSettingsForm app={app} /> : null}
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
