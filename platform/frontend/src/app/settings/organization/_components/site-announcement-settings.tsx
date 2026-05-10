"use client";

import { Megaphone, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  SettingsCardHeader,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { Textarea } from "@/components/ui/textarea";
import {
  useDeleteSiteAnnouncement,
  useSaveSiteAnnouncement,
  useSiteAnnouncementSettings,
} from "@/lib/site-announcement.query";

export function SiteAnnouncementSettings() {
  const { data: announcement } = useSiteAnnouncementSettings();
  const saveMutation = useSaveSiteAnnouncement();
  const deleteMutation = useDeleteSiteAnnouncement();
  const [content, setContent] = useState("");
  const [expiresAt, setExpiresAt] = useState("");

  useEffect(() => {
    setContent(announcement?.content ?? "");
    setExpiresAt(toDatetimeLocalValue(announcement?.expiresAt ?? null));
  }, [announcement]);

  const hasAnnouncement = !!announcement;
  const isDirty = useMemo(
    () =>
      content !== (announcement?.content ?? "") ||
      expiresAt !== toDatetimeLocalValue(announcement?.expiresAt ?? null),
    [announcement, content, expiresAt],
  );
  const canSave = content.trim().length > 0 && isDirty;

  return (
    <Card>
      <SettingsCardHeader
        title="Site Announcement"
        description="Show one markdown announcement across the main app until its expiration time."
      />
      <CardContent>
        <SettingsSectionStack>
          <div className="space-y-2">
            <Label htmlFor="siteAnnouncementContent">Announcement</Label>
            <Textarea
              id="siteAnnouncementContent"
              placeholder="Scheduled maintenance starts at 6 PM UTC. [Read more](https://status.example.com)."
              value={content}
              onChange={(event) => setContent(event.target.value)}
              maxLength={4000}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Markdown links are supported.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="siteAnnouncementExpiresAt">Expiration</Label>
            <Input
              id="siteAnnouncementExpiresAt"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to keep the announcement visible until it is removed.
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {hasAnnouncement && (
              <PermissionButton
                permissions={{ siteAnnouncement: ["delete"] }}
                variant="outline"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="size-4" />
                Delete
              </PermissionButton>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setContent(announcement?.content ?? "");
                setExpiresAt(
                  toDatetimeLocalValue(announcement?.expiresAt ?? null),
                );
              }}
              disabled={!isDirty || saveMutation.isPending}
            >
              Cancel
            </Button>
            <PermissionButton
              permissions={{
                siteAnnouncement: [hasAnnouncement ? "update" : "create"],
              }}
              onClick={() =>
                saveMutation.mutate({
                  mode: hasAnnouncement ? "update" : "create",
                  payload: {
                    content: content.trim(),
                    expiresAt: fromDatetimeLocalValue(expiresAt),
                  },
                })
              }
              disabled={!canSave || saveMutation.isPending}
            >
              <Megaphone className="size-4" />
              Save
            </PermissionButton>
          </div>
        </SettingsSectionStack>
      </CardContent>
    </Card>
  );
}

function toDatetimeLocalValue(value: string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  const offsetDate = new Date(
    date.getTime() - date.getTimezoneOffset() * 60000,
  );
  return offsetDate.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value: string) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}
