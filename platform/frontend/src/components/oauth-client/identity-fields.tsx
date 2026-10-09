"use client";

import { Copy, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

/**
 * What an OAuth client is and how it authenticates, read-only: the kind and
 * sign-in are fixed at creation, the client ID is public, and the secret is
 * only ever replaced, never shown again.
 */
export function OAuthClientIdentityFields({
  kindLabel,
  clientId,
  onRotateSecret,
}: {
  kindLabel: string;
  clientId: string;
  onRotateSecret?: () => void;
}) {
  return (
    <dl className="divide-y rounded-lg border px-4 text-sm">
      <div className="flex min-h-11 items-center gap-3 py-2">
        <dt className="w-28 shrink-0 text-muted-foreground">Kind</dt>
        <dd className="min-w-0 flex-1">{kindLabel}</dd>
        <span className="text-xs text-muted-foreground">Set at creation</span>
      </div>
      <div className="flex min-h-11 items-center gap-3 py-2">
        <dt className="w-28 shrink-0 text-muted-foreground">Client ID</dt>
        <dd className="min-w-0 flex-1 truncate font-mono text-xs">
          {clientId}
        </dd>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Copy client ID"
          onClick={async () => {
            await copyToClipboard(clientId);
            toast.success("Client ID copied");
          }}
        >
          <Copy />
        </Button>
      </div>
      <div className="flex min-h-11 items-center gap-3 py-2">
        <dt className="w-28 shrink-0 text-muted-foreground">Client secret</dt>
        <dd className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
          ••••••••••••
        </dd>
        {onRotateSecret && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRotateSecret}
          >
            <RotateCw />
            <span>Rotate</span>
          </Button>
        )}
      </div>
    </dl>
  );
}
