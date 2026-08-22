"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type PluginDetail,
  useApplyGithubPluginUpdate,
  usePreviewGithubPluginUpdate,
  useTriggerPluginGithubSync,
  useUpdatePluginGithubSync,
} from "@/lib/plugins/plugin.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { SkillContentEditor } from "../../skills/_parts/skill-content-editor";

const SYNC_OPTIONS = [
  { value: "off", label: "Manual checks" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "1d", label: "Every day" },
] as const;

export function PluginGithubUpdatesDialog({
  plugin,
  open,
  onOpenChange,
}: {
  plugin: PluginDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const check = useTriggerPluginGithubSync(plugin.id);
  const updateCadence = useUpdatePluginGithubSync(plugin.id);
  const preview = usePreviewGithubPluginUpdate(plugin.id);
  const apply = useApplyGithubPluginUpdate(plugin.id);
  const [previewRequested, setPreviewRequested] = useState(false);
  const candidate = plugin.pendingSourceSha;
  const previewMatchesCandidate =
    !!candidate &&
    preview.data?.commitSha.toLowerCase() === candidate.toLowerCase();

  const close = (nextOpen: boolean) => {
    if (!nextOpen) {
      preview.reset();
      setPreviewRequested(false);
    }
    onOpenChange(nextOpen);
  };

  return (
    <StandardDialog
      open={open}
      onOpenChange={close}
      title="GitHub updates"
      description="Check the tracked source and approve new plugin bytes before they are delivered."
      size="large"
      bodyClassName="space-y-5 overflow-y-auto"
      footer={
        <>
          <Button variant="outline" onClick={() => close(false)}>
            Close
          </Button>
          {previewMatchesCandidate && candidate && (
            <Button
              disabled={apply.isPending}
              onClick={async () => {
                const applied = await apply.mutateAsync(candidate);
                if (applied) close(false);
              }}
            >
              {apply.isPending ? "Applying..." : "Approve and apply"}
            </Button>
          )}
        </>
      }
    >
      <section className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="plugin-github-cadence">Check cadence</Label>
          <Select
            value={plugin.githubSyncInterval ?? "off"}
            disabled={updateCadence.isPending}
            onValueChange={(value) =>
              updateCadence.mutate(
                value === "off" ? null : (value as "15m" | "1h" | "1d"),
              )
            }
          >
            <SelectTrigger id="plugin-github-cadence" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SYNC_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Last checked {formatRelativeTimeFromNow(plugin.lastSyncedAt)}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          <RefreshCw className={check.isPending ? "animate-spin" : undefined} />
          Check now
        </Button>
      </section>

      {plugin.lastSyncError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {plugin.lastSyncError}
        </p>
      )}

      {candidate ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">Update ready for review</h3>
              <p className="font-mono text-xs text-muted-foreground">
                {plugin.sourceSha?.slice(0, 10) ?? "unknown"} →{" "}
                {candidate.slice(0, 10)}
              </p>
            </div>
            {!previewMatchesCandidate && (
              <Button
                disabled={preview.isPending}
                onClick={() => {
                  setPreviewRequested(true);
                  preview.mutate();
                }}
              >
                {preview.isPending && <Loader2 className="animate-spin" />}
                {preview.isPending ? "Loading..." : "Review files"}
              </Button>
            )}
          </div>
          {previewRequested && preview.data && (
            <SkillContentEditor
              manifest={null}
              files={preview.data.files}
              onManifestChange={() => {}}
              onFilesChange={() => {}}
              readOnly
              readOnlyMarker={false}
              className="h-[45vh] min-h-80"
            />
          )}
        </section>
      ) : (
        <p className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
          No update is waiting for approval.
        </p>
      )}
    </StandardDialog>
  );
}
