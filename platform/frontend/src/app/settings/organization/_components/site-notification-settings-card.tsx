"use client";

import { useEffect, useMemo, useState } from "react";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { SiteNotificationBanner } from "@/components/site-notification-banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface SiteNotificationValue {
  markdown: string | null;
  expiresAt: string | null;
}

interface SiteNotificationSettingsCardProps {
  initialNotification: SiteNotificationValue | null | undefined;
  canUpdate: boolean;
  isSaving: boolean;
  onSave: (notification: SiteNotificationValue) => Promise<unknown> | unknown;
}

export function SiteNotificationSettingsCard({
  initialNotification,
  canUpdate,
  isSaving,
  onSave,
}: SiteNotificationSettingsCardProps) {
  const initialMarkdown = initialNotification?.markdown ?? "";
  const initialExpiresAt = useMemo(
    () => toDatetimeLocalValue(initialNotification?.expiresAt),
    [initialNotification?.expiresAt],
  );

  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);

  useEffect(() => {
    setMarkdown(initialMarkdown);
    setExpiresAt(initialExpiresAt);
  }, [initialMarkdown, initialExpiresAt]);

  const hasChanges =
    markdown !== initialMarkdown || expiresAt !== initialExpiresAt;
  const previewMarkdown = markdown.trim();

  const handleSave = async () => {
    await onSave({
      markdown: previewMarkdown || null,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    });
  };

  return (
    <Card>
      <SettingsCardHeader
        title="Site Notification"
        description="Show one organization-wide announcement at the top of the app. Markdown links are supported."
      />
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="siteNotificationMarkdown">
            Announcement markdown
          </Label>
          <Textarea
            id="siteNotificationMarkdown"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            placeholder="For example: [Status page](https://status.example.com) is tracking this event."
            rows={5}
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="siteNotificationExpiresAt">Expires at</Label>
          <Input
            id="siteNotificationExpiresAt"
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to keep the announcement visible until you clear it.
          </p>
        </div>
        <div className="space-y-2">
          <Label>Preview</Label>
          {previewMarkdown ? (
            <SiteNotificationBanner markdown={previewMarkdown} />
          ) : (
            <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              Preview will appear here once you add announcement text.
            </div>
          )}
        </div>
      </CardContent>
      <CardFooter className="-mb-6 mt-2 flex flex-col gap-3 rounded-b-xl border-t bg-muted/30 py-4 sm:flex-row sm:items-center sm:justify-end">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setMarkdown(initialMarkdown);
            setExpiresAt(initialExpiresAt);
          }}
          disabled={isSaving || !hasChanges}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !hasChanges || !canUpdate}
        >
          {isSaving ? "Saving..." : "Save notification"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function toDatetimeLocalValue(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const pad = (part: number) => part.toString().padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
