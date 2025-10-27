import { Badge } from "@/components/ui/badge";

export function TransportBadges({
  isRemote,
  className,
}: {
  isRemote?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
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
        {!isRemote && (
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
