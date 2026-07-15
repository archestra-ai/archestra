"use client";

import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCreateSiteNotification,
  useDeleteSiteNotification,
  useSiteNotification,
  useUpdateSiteNotification,
} from "@/lib/site-notification.query";
import { formatDate } from "@/lib/utils";

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

export function SiteNotificationsSection() {
  const { data: canReadNotifications } = useHasPermissions({
    siteNotification: ["read"],
  });
  const { data: notification, isLoading } = useSiteNotification({
    enabled: canReadNotifications === true,
  });
  const createMutation = useCreateSiteNotification();
  const updateMutation = useUpdateSiteNotification();
  const deleteMutation = useDeleteSiteNotification();

  const [content, setContent] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null | undefined>(
    undefined,
  );
  const [tab, setTab] = useState<"markdown" | "preview">("markdown");

  const effectiveContent = content ?? notification?.content ?? "";
  const effectiveExpiresAt =
    expiresAt !== undefined
      ? expiresAt
      : notification?.expiresAt
        ? new Date(notification.expiresAt)
        : null;
  const hasChanges = notification
    ? content !== null || expiresAt !== undefined
    : content !== null || expiresAt !== undefined;
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const trimmedContent = effectiveContent.trim();

  const resetDraft = useCallback(() => {
    setContent(null);
    setExpiresAt(undefined);
  }, []);

  const handleSave = useCallback(async () => {
    if (!trimmedContent) {
      return;
    }

    if (!notification) {
      await createMutation.mutateAsync({
        content: trimmedContent,
        expiresAt: effectiveExpiresAt?.toISOString(),
      });
    } else {
      await updateMutation.mutateAsync({
        path: { id: notification.id },
        body: {
          content: trimmedContent,
          expiresAt: effectiveExpiresAt?.toISOString() ?? null,
          isActive: true,
        },
      });
    }

    resetDraft();
  }, [
    notification,
    trimmedContent,
    effectiveExpiresAt,
    createMutation,
    updateMutation,
    resetDraft,
  ]);

  const handleDelete = useCallback(async () => {
    if (!notification) return;
    await deleteMutation.mutateAsync({ path: { id: notification.id } });
    resetDraft();
  }, [notification, deleteMutation, resetDraft]);

  if (canReadNotifications === false) {
    return null;
  }

  return (
    <Card>
      <SettingsCardHeader
        title="Site Notifications"
        description="Manage a site-wide announcement banner displayed across the app."
      />
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading notification settings...
          </p>
        ) : (
          <>
            <ExpirationDateTimeField
              label="Expiration Date"
              value={effectiveExpiresAt}
              onChange={setExpiresAt}
              placeholder="No expiration"
              noExpirationText="Notification will not expire"
              formatExpiration={(value) =>
                value ? formatDate({ date: new Date(value).toISOString() }) : ""
              }
            />

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
                  aria-label="Notification content"
                  value={effectiveContent}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Write your notification content using markdown."
                  className="border-0 rounded-none font-mono text-sm min-h-[160px] resize-none focus-visible:ring-0"
                />
              ) : (
                <div className="p-4 min-h-[160px] [&_p]:my-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic">
                  {trimmedContent.length > 0 ? (
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

            <div className="flex items-center justify-between gap-3">
              <div>
                {notification && (
                  <PermissionButton
                    type="button"
                    variant="destructive"
                    size="sm"
                    permissions={{ siteNotification: ["delete"] }}
                    onClick={handleDelete}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Notification
                  </PermissionButton>
                )}
              </div>
              <div className="flex items-center gap-2">
                {hasChanges && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={resetDraft}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                )}
                <PermissionButton
                  type="button"
                  permissions={{
                    siteNotification: notification ? ["update"] : ["create"],
                  }}
                  onClick={handleSave}
                  disabled={!hasChanges || isSaving || !trimmedContent}
                >
                  {isSaving ? "Saving..." : "Save Notification"}
                </PermissionButton>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
