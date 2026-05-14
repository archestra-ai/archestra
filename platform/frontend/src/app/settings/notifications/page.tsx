"use client";

import { Bell, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  SettingsCardHeader,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateSiteNotification,
  useDeleteSiteNotification,
  useSiteNotification,
  useUpdateSiteNotification,
} from "@/lib/site-notification.query";

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      const code = String(children).replace(/\n$/, "");
      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 border p-3 text-xs">
          <code className={className} {...props}>
            {code}
          </code>
        </pre>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export default function NotificationsSettingsPage() {
  const { data: notification, isLoading } = useSiteNotification();
  const createMutation = useCreateSiteNotification();
  const updateMutation = useUpdateSiteNotification();
  const deleteMutation = useDeleteSiteNotification();

  const [content, setContent] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [isActive, setIsActive] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"markdown" | "preview">("markdown");

  const effectiveContent = content ?? notification?.content ?? "";
  const effectiveExpiresAt =
    expiresAt ?? notification?.expiresAt?.slice(0, 16) ?? "";
  const effectiveIsActive = isActive ?? notification?.isActive ?? true;

  const hasChanges = notification
    ? content !== null || expiresAt !== null || isActive !== null
    : content !== null || expiresAt !== null;

  const handleSave = useCallback(async () => {
    if (!notification && effectiveContent) {
      await createMutation.mutateAsync({
        content: effectiveContent,
        expiresAt: effectiveExpiresAt
          ? new Date(effectiveExpiresAt).toISOString()
          : undefined,
      });
    } else if (notification) {
      if (effectiveContent || isActive !== null) {
        await updateMutation.mutateAsync({
          id: notification.id,
          content: effectiveContent,
          expiresAt: effectiveExpiresAt
            ? new Date(effectiveExpiresAt).toISOString()
            : null,
          isActive: effectiveIsActive,
        });
      }
    }
    setContent(null);
    setExpiresAt(null);
    setIsActive(null);
  }, [
    notification,
    effectiveContent,
    effectiveExpiresAt,
    effectiveIsActive,
    isActive,
    createMutation,
    updateMutation,
  ]);

  const handleDelete = useCallback(async () => {
    if (!notification) return;
    await deleteMutation.mutateAsync(notification.id);
  }, [notification, deleteMutation]);

  const handleCancel = useCallback(() => {
    setContent(null);
    setExpiresAt(null);
    setIsActive(null);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-lg text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <SettingsSectionStack>
      <div>
        <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Site Notifications
        </h3>
        <SettingsSectionStack>
          <Card>
            <SettingsCardHeader
              title="Notification Content"
              description="Create a site-wide notification banner displayed to all users. Supports markdown formatting."
            />
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label>Enable Notification</Label>
                  <p className="text-xs text-muted-foreground">
                    Show the notification banner to all users
                  </p>
                </div>
                <Switch
                  checked={effectiveIsActive}
                  onCheckedChange={(checked) => setIsActive(checked)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="expiresAt">Expiration Date (Optional)</Label>
                <Input
                  id="expiresAt"
                  type="datetime-local"
                  value={effectiveExpiresAt}
                  onChange={(e) => setExpiresAt(e.target.value || null)}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty for no expiration. The notification will
                  auto-expire at the specified time.
                </p>
              </div>

              <div className="rounded-lg border">
                <div className="flex items-center gap-1 border-b p-1">
                  <Button
                    type="button"
                    variant={tab === "markdown" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setTab("markdown")}
                  >
                    Markdown
                  </Button>
                  <Button
                    type="button"
                    variant={tab === "preview" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setTab("preview")}
                  >
                    Preview
                  </Button>
                </div>
                {tab === "markdown" ? (
                  <Textarea
                    value={effectiveContent}
                    onChange={(e) => setContent(e.target.value || null)}
                    placeholder="Write your notification content using markdown. Support for **bold**, *italic*, [links](url), lists, and more."
                    className="border-0 rounded-none font-mono text-sm min-h-[200px] resize-none focus-visible:ring-0"
                  />
                ) : (
                  <div className="p-4 min-h-[200px] [&_p]:my-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic">
                    {effectiveContent.trim().length > 0 ? (
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                      >
                        {effectiveContent}
                      </ReactMarkdown>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No content to preview.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {notification && (
                <div className="flex items-center justify-end">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Notification
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </SettingsSectionStack>
      </div>

      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={createMutation.isPending || updateMutation.isPending}
        onSave={handleSave}
        onCancel={handleCancel}
        permissions={{ siteNotification: ["create", "update"] }}
      />
    </SettingsSectionStack>
  );
}
