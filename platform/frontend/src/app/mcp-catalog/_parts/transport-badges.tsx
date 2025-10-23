import { Badge } from "@/components/ui/badge";
import type { ServerResponse } from "@/lib/clients/mcp-registry";

export function TransportBadges({ server }: { server: ServerResponse }) {
  return (
    <div>
      <div className="flex flex-wrap gap-1 mt-2">
        {/* Remote vs Local badge */}
        {server.server.remotes && server.server.remotes.length > 0 && (
          <Badge variant="outline" className="text-xs bg-blue-700 text-white">
            Remote
          </Badge>
        )}
        {server.server.remotes?.map((remote, index) => (
          <Badge
            key={`remote-${remote.type}-${remote.url || index}`}
            variant="secondary"
            className="text-xs bg-gray-500 text-white"
          >
            {remote.type}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap gap-1 mt-2">
        {server.server.packages && server.server.packages.length > 0 && (
          <Badge
            variant="outline"
            className="text-xs bg-emerald-700 text-white"
          >
            Local
          </Badge>
        )}
        {server.server.packages?.map((pkg, index) => (
          <Badge
            key={`package-${pkg.transport.type}-${pkg.transport.url || index}`}
            variant="secondary"
            className="text-xs bg-gray-500 text-white"
          >
            {pkg.transport.type}
          </Badge>
        ))}
      </div>
    </div>
  );
}
