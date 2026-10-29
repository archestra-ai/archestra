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
    <dl className="@container/identity divide-y rounded-lg border px-4 text-sm">
      <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 @[400px]/identity:grid-cols-[7rem_minmax(0,1fr)_auto] @[400px]/identity:py-2">
        <dt className="col-span-2 text-muted-foreground @[400px]/identity:col-span-1">
          Kind
        </dt>
        <dd className="min-w-0 flex-1">{kindLabel}</dd>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          Set at creation
        </span>
      </div>
      <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 @[400px]/identity:grid-cols-[7rem_minmax(0,1fr)_auto] @[400px]/identity:py-2">
        <dt className="col-span-2 text-muted-foreground @[400px]/identity:col-span-1">
          Client ID
        </dt>
        <dd className="min-w-0 flex-1 truncate font-mono text-xs">
          {clientId}
        </dd>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label="Copy client ID"
          onClick={async () => {
            await copyToClipboard(clientId);
            toast.success("Client ID copied");
          }}
        >
          <Copy />
        </Button>
      </div>
      <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-3 @[400px]/identity:grid-cols-[7rem_minmax(0,1fr)_auto] @[400px]/identity:py-2">
        <dt className="col-span-2 text-muted-foreground @[400px]/identity:col-span-1">
          Client secret
        </dt>
        <dd className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          ••••••••••••
        </dd>
        {onRotateSecret && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
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
