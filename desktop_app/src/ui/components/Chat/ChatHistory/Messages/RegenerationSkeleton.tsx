import { RefreshCw } from 'lucide-react';

import { Skeleton } from '@ui/components/ui/skeleton';
import { cn } from '@ui/lib/utils';

interface RegenerationSkeletonProps {
  className?: string;
}

export default function RegenerationSkeleton({ className }: RegenerationSkeletonProps) {
  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>Regenerating response...</span>
      </div>

      <div className="space-y-2">
        <Skeleton className="h-3.5 w-3/4 bg-muted-foreground/50" />
        <Skeleton className="h-3.5 w-full bg-muted-foreground/50" />
        <Skeleton className="h-3.5 w-2/3 bg-muted-foreground/50" />
      </div>
    </div>
  );
}
