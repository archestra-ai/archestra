import { RefreshCw, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { getMcpServerLogs } from '@ui/lib/clients/archestra/api/gen';

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

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getMcpServerLogs({ path: { id: mcpServerId }, query: { lines: 500 } });
      if (response.data) {
        setLogs(response.data.logs || 'No logs available');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      fetchLogs();
    }
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

        <div className="flex items-center justify-end mb-2">
          <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={loading} className="flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
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
