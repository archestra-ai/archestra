"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { downloadZip } from "@/components/file-workspace/download-zip";
import { Button } from "@/components/ui/button";
import type { PluginFileDraft } from "./plugin-content-fields";

/**
 * Saves the whole plugin, as it stands in the form, as a .zip.
 *
 * It sits in the page header with the plugin's other whole-plugin actions.
 * On the file editor's bar it read as "download the open file".
 */
export function PluginDownloadButton({
  name,
  files,
}: {
  /** Names the archive: the plugin's slug, or its display name. */
  name: string;
  files: PluginFileDraft[];
}) {
  const [pending, setPending] = useState(false);
  const save = () => {
    setPending(true);
    downloadZip({
      name: name.trim() || "plugin",
      files: files.map(({ path, content, encoding }) => ({
        path,
        content,
        encoding,
      })),
    })
      .catch(() => toast.error("Could not download the files"))
      .finally(() => setPending(false));
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending || files.length === 0}
      onClick={save}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Download className="h-4 w-4" aria-hidden />
      )}
      <span>Download</span>
    </Button>
  );
}
