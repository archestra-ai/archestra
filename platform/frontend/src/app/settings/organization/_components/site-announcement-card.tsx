"use client";

import { Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SettingsCardHeader } from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteSiteAnnouncement,
  useSiteAnnouncement,
  useUpsertSiteAnnouncement,
} from "@/lib/site-announcement.query";

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDateTimeLocal(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function SiteAnnouncementCard() {
  const { data: announcement, isPending } = useSiteAnnouncement();
  const upsertMutation = useUpsertSiteAnnouncement();
  const deleteMutation = useDeleteSiteAnnouncement();
  const [markdown, setMarkdown] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    setMarkdown(announcement?.markdown ?? "");
    setExpiresAt(toDateTimeLocal(announcement?.expiresAt));
  }, [announcement]);

  const hasChanges = useMemo(
    () =>
      markdown !== (announcement?.markdown ?? "") ||
      expiresAt !== toDateTimeLocal(announcement?.expiresAt),
    [announcement, expiresAt, markdown],
  );

  const isSaving = upsertMutation.isPending || deleteMutation.isPending;
  const canSave = markdown.trim().length > 0 && hasChanges;

  return (
    <Card>
      <SettingsCardHeader
        title="Site announcement"
        description="Show one organization-wide announcement at the top of the app. Markdown links, bold, and italic text are supported."
      />
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="site-announcement-markdown">Announcement</Label>
          <Textarea
            id="site-announcement-markdown"
            placeholder="Example: **Maintenance tonight** from 9-10 PM. [Status page](https://status.example.com)"
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
            maxLength={2000}
            rows={4}
            disabled={isPending || isSaving}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="site-announcement-expires-at">Expiration</Label>
          <Input
            id="site-announcement-expires-at"
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            disabled={isPending || isSaving}
          />
        </div>
        <WithPermissions
          permissions={{ siteAnnouncement: ["create", "update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setMarkdown(announcement?.markdown ?? "");
                  setExpiresAt(toDateTimeLocal(announcement?.expiresAt));
                }}
                disabled={!hasPermission || isSaving || !hasChanges}
              >
                Reset
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => deleteMutation.mutate()}
                disabled={!hasPermission || isSaving || !announcement}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
              <Button
                type="button"
                onClick={() =>
                  upsertMutation.mutate({
                    markdown: markdown.trim(),
                    expiresAt: fromDateTimeLocal(expiresAt),
                  })
                }
                disabled={!hasPermission || isSaving || !canSave}
              >
                <Save className="h-4 w-4" />
                Save
              </Button>
            </div>
          )}
        </WithPermissions>
      </CardContent>
    </Card>
  );
}
