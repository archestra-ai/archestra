import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ChannelTilesLoading() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {["skeleton-1", "skeleton-2", "skeleton-3"].map((key) => (
        <Card key={key} className="py-4">
          <CardContent className="flex flex-col gap-3 px-4">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-7 w-16 ml-auto rounded" />
            </div>
            <Skeleton className="h-px w-full" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-7 w-14 rounded" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
