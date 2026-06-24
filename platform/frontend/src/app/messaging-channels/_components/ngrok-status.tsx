import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { useDisconnectNgrok } from "@/lib/chatops/chatops-config.query";

/**
 * Shows the active ngrok tunnel's public URL with a Stop control. Rendered in
 * the "reachable from the Internet" setup step once a tunnel is connected.
 */
export function NgrokStatus({ domain }: { domain: string }) {
  const disconnect = useDisconnectNgrok();
  const url = `https://${domain.replace(/^https?:\/\//, "")}`;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-green-500" />
        <span className="truncate">
          Tunnel active at{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-xs">{url}</code>
        </span>
        <CopyButton text={url} />
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 text-xs"
        disabled={disconnect.isPending}
        onClick={() => disconnect.mutate()}
      >
        {disconnect.isPending ? "Stopping…" : "Stop"}
      </Button>
    </div>
  );
}
