import { Badge } from "@/components/ui/badge";

export function TransportBadges({
  isRemote,
  transportType,
  className,
}: {
  isRemote?: boolean;
  transportType?: string | null;
  className?: string;
}) {
  const displayTransportType = isRemote ? "HTTP" : transportType || "stdio";

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {isRemote && (
          <Badge variant="outline" className="text-xs bg-blue-700 text-white">
            Remote
          </Badge>
        )}
        {!isRemote && (
          <Badge
            variant="outline"
            className="text-xs bg-emerald-700 text-white"
          >
            Self-hosted
          </Badge>
        )}
        <Badge variant="secondary" className="text-xs bg-gray-500 text-white">
          {displayTransportType}
        </Badge>
      </div>
    </div>
  );
}
