import { Loader2 } from "lucide-react";
import { useAnimatedDots } from "@/lib/animated-dots.hook";

interface LogsEmptyStateProps {
  isLoading: boolean;
  hasFilters: boolean;
  /**
   * Message shown when no results exist and no filters are applied.
   * e.g. "Logs will appear here when agents start making requests."
   */
  emptyMessage: string;
}

export function LogsEmptyState({
  isLoading,
  hasFilters,
  emptyMessage,
}: LogsEmptyStateProps) {
  const loadingDots = useAnimatedDots(isLoading);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-20rem)] gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Loading{loadingDots}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-[calc(100vh-20rem)]">
      <p className="text-muted-foreground text-sm">
        {hasFilters
          ? "No results match your filters. Try adjusting your search."
          : emptyMessage}
      </p>
    </div>
  );
}
