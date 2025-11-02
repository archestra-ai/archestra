import { RefreshCw, Terminal, Play, Square } from 'lucide-react';
import { useEffect, useState, useRef } from 'react';

import { Button } from '@ui/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { getMcpServerLogs } from '@ui/lib/clients/archestra/api/gen';
import config from '@ui/config';

interface LogViewerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mcpServerId: string;
  mcpServerName: string;
}

export default function LogViewerDialog({ open, onOpenChange, mcpServerId, mcpServerName }: LogViewerDialogProps) {
  const [logs, setLogs] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFollowing, setIsFollowing] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getMcpServerLogs({ path: { id: mcpServerId }, query: { lines: 500, follow: false } });
      if (response.data) {
        setLogs(response.data.logs || 'No logs available');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  };

  const startFollowing = async () => {
    setIsFollowing(true);
    setError(null);

    // Create an abort controller for this stream
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const response = await fetch(
        `${config.archestra.apiUrl}/api/mcp_server/${mcpServerId}/logs?lines=500&follow=true`,
        {
          signal: abortController.signal,
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to stream logs: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('No response body');
      }

      // Clear existing logs when starting to follow
      setLogs('');

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        setLogs((prev) => prev + chunk);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setError(err.message);
      }
    } finally {
      setIsFollowing(false);
      abortControllerRef.current = null;
    }
  };

  const stopFollowing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsFollowing(false);
  };

  useEffect(() => {
    if (open) {
      fetchLogs();
    } else {
      // Clean up when dialog closes
      stopFollowing();
    }

    // Cleanup on unmount
    return () => {
      stopFollowing();
    };
  }, [open, mcpServerId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1200px] w-[90vw] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            {mcpServerName} - Container Logs
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2 mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchLogs}
            disabled={loading || isFollowing}
            className="flex items-center gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {!isFollowing ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={startFollowing}
              disabled={loading}
              className="flex items-center gap-2"
            >
              <Play className="h-4 w-4" />
              Follow
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={stopFollowing}
              className="flex items-center gap-2"
            >
              <Square className="h-4 w-4" />
              Stop
            </Button>
          )}
        </div>

        <div className="flex-1 rounded-md border bg-black/90 overflow-auto">
          <div className="p-4 min-w-max">
            {error ? (
              <div className="text-red-400 font-mono text-sm">Error: {error}</div>
            ) : (
              <pre className="font-mono text-sm text-green-400 whitespace-pre">{logs}</pre>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
