import { Check, Shield, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Checkbox } from '@ui/components/ui/checkbox';
import { useToolsStore } from '@ui/stores';

interface ToolApprovalMessageProps {
  requestId: string;
  toolId: string;
  toolName: string;
  toolDescription?: string;
  args: Record<string, any>;
  isWrite: boolean;
  sessionId: string;
  chatId: number;
}

export default function ToolApprovalMessage({
  requestId,
  toolName,
  toolDescription,
  args,
  isWrite,
}: ToolApprovalMessageProps) {
  const { approveRequest, declineRequest, pendingApprovals } = useToolsStore();
  const [rememberChoice, setRememberChoice] = useState(false);

  // Check if this request is still pending
  const isPending = pendingApprovals.has(requestId);

  const formattedArgs = useMemo(() => {
    if (!args) return null;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }, [args]);

  const handleApprove = useCallback(() => {
    approveRequest(requestId, rememberChoice);
    setRememberChoice(false);
  }, [requestId, rememberChoice, approveRequest]);

  const handleDecline = useCallback(() => {
    declineRequest(requestId, rememberChoice);
    setRememberChoice(false);
  }, [requestId, rememberChoice, declineRequest]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + Enter to approve
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        handleApprove();
      }
      // Escape to decline
      else if (e.key === 'Escape') {
        e.preventDefault();
        handleDecline();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // If not pending, don't show anything (request was already handled)
  if (!isPending) {
    return null;
  }

  return (
    <div className="border-2 border-yellow-500/50 bg-yellow-50/50 dark:bg-yellow-900/20 rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <Shield className="h-5 w-5 text-yellow-600 dark:text-yellow-500 mt-0.5 flex-shrink-0" />

        <div className="flex-1 space-y-3">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-2">
              Tool Approval Required
              {isWrite && (
                <Badge variant="destructive" className="text-xs">
                  Write Access
                </Badge>
              )}
            </h4>
            <p className="text-sm text-muted-foreground mt-1">
              The AI wants to use <span className="font-mono font-semibold">{toolName}</span>
            </p>
            {toolDescription && <p className="text-xs text-muted-foreground mt-1">{toolDescription}</p>}
          </div>

          {formattedArgs && (
            <div className="bg-muted/50 rounded p-2 max-h-32 overflow-auto">
              <pre className="text-xs font-mono">{formattedArgs}</pre>
            </div>
          )}

          <div className="flex items-center space-x-2">
            <Checkbox
              id={`remember-${requestId}`}
              checked={rememberChoice}
              onCheckedChange={(checked) => setRememberChoice(!!checked)}
              className="h-3 w-3 cursor-pointer"
            />
            <label
              htmlFor={`remember-${requestId}`}
              className="text-xs font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Don't ask again for this tool in this session
            </label>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={handleApprove}
              className="h-7 text-xs cursor-pointer"
              title="Approve (⌘ + Enter / Ctrl + Enter)"
            >
              <Check className="h-3 w-3 mr-1" />
              Approve
              <kbd className="ml-1.5 px-1 py-0.5 text-[10px] font-semibold bg-white/20 rounded">Cmd + Enter</kbd>
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={handleDecline}
              className="h-7 text-xs cursor-pointer"
              title="Decline (Escape)"
            >
              <X className="h-3 w-3 mr-1" />
              Decline
              <kbd className="ml-1.5 px-1 py-0.5 text-[10px] font-semibold bg-white/20 rounded">Esc</kbd>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
