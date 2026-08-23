"use client";

import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Editor } from "@/components/editor";
import { ExpirationDateTimeField } from "@/components/expiration-date-time-field";
import { SettingsBlock } from "@/components/settings/settings-block";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useDeleteSiteNotification,
  useSiteNotification,
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

interface SiteNotificationsSectionProps {
  /** Effective draft content (page-owned state falling back to the server value). */
  content: string;
  /** Effective draft expiration; `null` = no expiration. */
  expiresAt: Date | null;
  onContentChange: (content: string) => void;
  onExpiresAtChange: (expiresAt: Date | null) => void;
  /** Called after the notification is deleted so the page can drop its draft. */
  onDeleted: () => void;
}

/**
 * Site-notification editor. The draft state lives in the appearance page so
 * changes here save through the page's single floating save bar; only the
 * immediate delete action stays local.
 */
export function SiteNotificationsSection({
  content,
  expiresAt,
  onContentChange,
  onExpiresAtChange,
  onDeleted,
}: SiteNotificationsSectionProps) {
  const { data: canReadNotifications } = useHasPermissions({
    siteNotification: ["read"],
  });
  const { data: notification, isLoading } = useSiteNotification({
    enabled: canReadNotifications === true,
  });
  const deleteMutation = useDeleteSiteNotification();

  const trimmedContent = content.trim();

  const handleDelete = useCallback(async () => {
    if (!notification) return;
    await deleteMutation.mutateAsync({ path: { id: notification.id } });
    onDeleted();
  }, [notification, deleteMutation, onDeleted]);

  if (canReadNotifications === false) {
    return null;
  }

  return (
    <SettingsBlock
      title="Site Notifications"
      description="Manage a site-wide announcement banner displayed across the app."
    >
      <div className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading notification settings...
          </p>
        ) : (
          <>
            <ExpirationDateTimeField
              label="Expiration Date"
              value={expiresAt}
              onChange={onExpiresAtChange}
              placeholder="No expiration"
              noExpirationText="Notification will not expire"
              formatExpiration={(value) =>
                value ? formatDate({ date: new Date(value).toISOString() }) : ""
              }
            />

            <div className="grid overflow-hidden rounded-lg border lg:grid-cols-2">
              <div className="min-w-0 border-b lg:border-b-0 lg:border-r">
                <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                  Markdown
                </div>
                <Editor
                  height="240px"
                  defaultLanguage="markdown"
                  value={content}
                  onChange={(value) => onContentChange(value ?? "")}
                  options={{
                    ariaLabel: "Notification content",
                    minimap: { enabled: false },
                    lineNumbers: "off",
                    folding: false,
                    glyphMargin: false,
                    lineDecorationsWidth: 8,
                    lineNumbersMinChars: 0,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    fontSize: 13,
                    padding: { top: 10, bottom: 10 },
                    placeholder:
                      "Write your notification content using markdown.",
                  }}
                />
              </div>
              <div className="min-w-0">
                <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                  Preview
                </div>
                <div className="h-[240px] overflow-y-auto p-4 [&_p]:my-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic">
                  {trimmedContent.length > 0 ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {content}
                    </ReactMarkdown>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No content to preview.
                    </p>
                  )}
                </div>
              </div>
            </div>

            {notification && (
              <div className="flex items-center justify-between gap-3">
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
              </div>
            )}
          </>
        )}
      </div>
    </SettingsBlock>
  );
}
