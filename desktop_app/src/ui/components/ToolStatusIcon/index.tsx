import { cn } from '@ui/lib/utils/tailwind';

interface ToolStatusIconProps {
  enabled: boolean;
  isRead?: boolean | null;
  isWrite?: boolean | null;
}

export default function ToolStatusIcon({ enabled, isRead, isWrite }: ToolStatusIconProps) {
  if (!enabled) {
    return <div className="w-1.5 h-1.5 bg-red-500 rounded-full" />;
  }

  // Determine color based on read/write status
  const colorClass =
    isRead && isWrite ? 'bg-blue-500' : isWrite ? 'bg-orange-500' : isRead ? 'bg-green-500' : 'bg-gray-500';

  return <div className={cn('w-1.5 h-1.5 rounded-full', colorClass)} />;
}
