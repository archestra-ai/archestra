import { Activity, AlertCircle, Info, Zap } from 'lucide-react';
import { useMemo } from 'react';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/ui/tooltip';
import { cn } from '@ui/lib/utils/tailwind';

interface TokenUsageDisplayProps {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  model?: string | null;
  contextWindow?: number | null;
  variant?: 'inline' | 'detailed';
  className?: string;
}

export default function TokenUsageDisplay({
  promptTokens,
  completionTokens,
  totalTokens,
  model,
  contextWindow,
  variant = 'inline',
  className,
}: TokenUsageDisplayProps) {
  const contextUsagePercent = useMemo(() => {
    if (!totalTokens || !contextWindow || contextWindow === 0) return 0;
    return Math.min(100, (totalTokens / contextWindow) * 100);
  }, [totalTokens, contextWindow]);

  const contextUsageColor = useMemo(() => {
    if (contextUsagePercent < 50) return 'text-green-600 dark:text-green-400';
    if (contextUsagePercent < 70) return 'text-yellow-600 dark:text-yellow-400';
    if (contextUsagePercent < 90) return 'text-orange-600 dark:text-orange-400';
    return 'text-red-600 dark:text-red-400';
  }, [contextUsagePercent]);

  const progressBarColor = useMemo(() => {
    if (contextUsagePercent < 50) return 'bg-green-500';
    if (contextUsagePercent < 70) return 'bg-yellow-500';
    if (contextUsagePercent < 90) return 'bg-orange-500';
    return 'bg-red-500';
  }, [contextUsagePercent]);

  if (!totalTokens) {
    return null;
  }

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return num.toString();
  };

  const remainingTokens = contextWindow ? contextWindow - totalTokens : null;

  if (variant === 'detailed') {
    return (
      <div className={cn('space-y-2 rounded-lg border p-3', className)}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Token Usage</span>
          </div>
          {model && <span className="text-xs text-muted-foreground">{model}</span>}
        </div>

        {contextWindow && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span>Context Usage</span>
              <span className={cn('font-medium', contextUsageColor)}>
                {formatNumber(totalTokens)} / {formatNumber(contextWindow)} ({contextUsagePercent.toFixed(1)}%)
              </span>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20">
              <div
                className={cn('h-full transition-all', progressBarColor)}
                style={{ width: `${contextUsagePercent}%` }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="space-y-1">
            <div className="text-muted-foreground">Prompt</div>
            <div className="font-medium">{formatNumber(promptTokens || 0)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground">Completion</div>
            <div className="font-medium">{formatNumber(completionTokens || 0)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-muted-foreground">Total</div>
            <div className="font-medium">{formatNumber(totalTokens)}</div>
          </div>
        </div>

        {remainingTokens !== null && (
          <div className="flex items-center justify-between border-t pt-2 text-xs">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-medium">{formatNumber(remainingTokens)} tokens</span>
          </div>
        )}
      </div>
    );
  }

  // Inline variant
  const getIcon = () => {
    if (contextUsagePercent >= 90) return <AlertCircle className="h-3 w-3" />;
    if (contextUsagePercent >= 70) return <Zap className="h-3 w-3" />;
    return <Activity className="h-3 w-3" />;
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs',
              'bg-muted/50 hover:bg-muted transition-colors cursor-help',
              className
            )}
          >
            <span className={cn('transition-colors', contextUsageColor)}>{getIcon()}</span>
            <span className="font-medium">
              {formatNumber(totalTokens)}
              {contextWindow && <span className="text-muted-foreground"> / {formatNumber(contextWindow)}</span>}
            </span>
            {contextWindow && (
              <span className={cn('font-medium', contextUsageColor)}>({contextUsagePercent.toFixed(0)}%)</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-2">
            {model && (
              <div className="flex items-center gap-2 border-b pb-2">
                <Info className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs font-medium">{model}</span>
              </div>
            )}

            <div className="space-y-1 text-xs">
              {contextWindow && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Context Window:</span>
                  <span className="font-medium">{formatNumber(contextWindow)} tokens</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-foreground">Prompt:</span>
                <span className="font-medium">{formatNumber(promptTokens || 0)} tokens</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Completion:</span>
                <span className="font-medium">{formatNumber(completionTokens || 0)} tokens</span>
              </div>
              <div className="flex justify-between border-t pt-1">
                <span className="text-muted-foreground">Total:</span>
                <span className="font-medium">
                  {formatNumber(totalTokens)} tokens
                  {contextWindow && (
                    <span className={cn('ml-1', contextUsageColor)}>({contextUsagePercent.toFixed(1)}%)</span>
                  )}
                </span>
              </div>
              {remainingTokens !== null && (
                <div className="flex justify-between border-t pt-1">
                  <span className="text-muted-foreground">Remaining:</span>
                  <span className="font-medium">{formatNumber(remainingTokens)} tokens</span>
                </div>
              )}
            </div>

            {contextUsagePercent >= 90 && (
              <div className="border-t pt-2">
                <div className="flex items-start gap-1 text-xs text-red-600 dark:text-red-400">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>Approaching context limit. Consider starting a new chat.</span>
                </div>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
