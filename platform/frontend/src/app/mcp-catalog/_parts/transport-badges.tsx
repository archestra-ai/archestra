import { Badge } from "@/components/ui/badge";
import type { ArchestraMcpServerManifest } from "@/lib/clients/archestra-catalog";

export function TransportBadges({
  server,
  className,
}: {
  server: ArchestraMcpServerManifest;
  className?: string;
}) {
  const isRemote = server.server.type === "remote";
  const isLocal = server.server.type === "local";

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1">
        {isRemote && (
          <>
            <Badge variant="outline" className="text-xs bg-blue-700 text-white">
              Remote
            </Badge>
            <Badge
              variant="secondary"
              className="text-xs bg-gray-500 text-white"
            >
              HTTP
            </Badge>
          </>
        )}
        {isLocal && (
          <>
            <Badge
              variant="outline"
              className="text-xs bg-emerald-700 text-white"
            >
              Local
            </Badge>
            <Badge
              variant="secondary"
              className="text-xs bg-gray-500 text-white"
            >
              stdio
            </Badge>
          </>
        )}
      </div>
    </div>
  );
}
