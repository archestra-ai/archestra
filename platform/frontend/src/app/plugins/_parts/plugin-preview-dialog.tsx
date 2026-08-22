"use client";

import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import type { GithubPluginPreview } from "@/lib/plugins/plugin.query";
import { SkillContentEditor } from "../../skills/_parts/skill-content-editor";

/** Read-only look at a marketplace plugin that has not been imported yet. */
export function PluginPreviewDialog({
  pluginName,
  preview,
  isLoading,
  hasError,
  open,
  onOpenChange,
}: {
  pluginName: string | null;
  preview: GithubPluginPreview | null;
  isLoading?: boolean;
  hasError?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={pluginName ?? "Preview plugin"}
      description="Preview of a plugin that has not been imported yet."
      size="large"
      bodyClassName="flex flex-col overflow-hidden"
      footer={
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      {hasError ? (
        <div className="py-10 text-center text-sm text-destructive">
          Plugin preview could not be loaded.
        </div>
      ) : isLoading || !preview ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          Loading plugin...
        </div>
      ) : (
        <SkillContentEditor
          manifest={null}
          files={preview.files.map(({ path, content, encoding }) => ({
            path,
            content,
            encoding,
          }))}
          onManifestChange={() => {}}
          onFilesChange={() => {}}
          readOnly
          readOnlyMarker={false}
          className="h-full"
        />
      )}
    </StandardDialog>
  );
}
