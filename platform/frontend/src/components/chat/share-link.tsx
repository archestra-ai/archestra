// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { Check, Copy, Link2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * The shared object's link, shown above who can open it. The URL is display
 * text, not a field, so opening the dialog never focuses or selects it.
 */
export function ShareLink({
  path,
  label,
  toastMessage,
}: {
  /** App path, such as `/chat/<id>`. The origin is added at render time. */
  path: string;
  label: string;
  toastMessage: string;
}) {
  const url = `${typeof window === "undefined" ? "" : window.location.origin}${path}`;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyToClipboard(url);
    setCopied(true);
    toast.success(toastMessage);
    setTimeout(() => setCopied(false), 2000);
  };
  const CopyIcon = copied ? Check : Copy;

  return (
    <div className="mb-4 space-y-1.5">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex h-9 items-stretch overflow-hidden rounded-md border bg-muted/30">
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
          <Link2 className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate select-all font-mono text-xs" title={url}>
            {shortenLink(url)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={copy}
          className="h-auto min-w-28 rounded-none border-l px-3 focus-visible:border-l-border focus-visible:ring-inset"
        >
          <CopyIcon className="size-4" />
          <span>{copied ? "Copied" : "Copy link"}</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Only the people and groups below can open it.
      </p>
    </div>
  );
}

/**
 * Drop the scheme and shorten a trailing UUID, so the link reads as a place:
 * `archestra.example.com/chat/e1ef38d7…9fc4`.
 */
function shortenLink(url: string) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(
      /([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})$/i,
      "$1…$2",
    );
}
