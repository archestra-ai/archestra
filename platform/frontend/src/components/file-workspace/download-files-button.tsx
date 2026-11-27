"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { type ArchiveFile, downloadZip } from "./download-zip";

/**
 * Saves a whole skill or plugin, as it stands on the page, as a .zip.
 *
 * It sits in the page header with the other actions on the whole thing. On
 * the file editor's bar it read as "download the open file".
 */
export function DownloadFilesButton({
  name,
  files,
}: {
  /** Names the archive. */
  name: string;
  files: ArchiveFile[];
}) {
  const [pending, setPending] = useState(false);
  const save = () => {
    setPending(true);
    downloadZip({ name: name.trim() || "files", files })
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
      {/* Icon only on a phone: the header there has room for the page's
          title or for this word, not both. The name stays for a screen
          reader. */}
      <span className="sr-only sm:not-sr-only">Download</span>
    </Button>
  );
}
