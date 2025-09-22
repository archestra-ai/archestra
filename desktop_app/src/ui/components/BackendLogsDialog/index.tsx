import { Bug, CheckCircle, Copy, ExternalLink, FileText, RefreshCw, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@ui/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/components/ui/tabs';
import { getSystemBackendLogs } from '@ui/lib/clients/archestra/api/gen';
import logCapture from '@ui/utils/logCapture';

interface BugReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReportBug?: () => void;
  appVersion?: string;
  systemInfo?: any;
}

export default function BugReportDialog({
  open,
  onOpenChange,
  onReportBug,
  appVersion,
  systemInfo,
}: BugReportDialogProps) {
  const [backendLogs, setBackendLogs] = useState<string>('');
  const [frontendLogs, setFrontendLogs] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedBackend, setCopiedBackend] = useState(false);
  const [copiedFrontend, setCopiedFrontend] = useState(false);
  const [activeTab, setActiveTab] = useState<'backend' | 'frontend'>('backend');

  const fetchBackendLogs = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error } = await getSystemBackendLogs({
        query: {
          lines: '1000',
        },
      });
      if (error) {
        setError(error.error || 'Failed to fetch logs');
        setBackendLogs('');
      } else if (data) {
        setBackendLogs(data.logs || 'No logs available');
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
      setBackendLogs('');
    } finally {
      setLoading(false);
    }
  };

  const fetchFrontendLogs = () => {
    const logs = logCapture.getFormattedLogs();
    setFrontendLogs(logs || 'No frontend logs captured');
  };

  const handleCopyBackendLogs = async () => {
    try {
      await navigator.clipboard.writeText(backendLogs);
      setCopiedBackend(true);
      setTimeout(() => setCopiedBackend(false), 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  const handleCopyFrontendLogs = async () => {
    try {
      await navigator.clipboard.writeText(frontendLogs);
      setCopiedFrontend(true);
      setTimeout(() => setCopiedFrontend(false), 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  const handleCopyAllLogs = async () => {
    try {
      const allLogs = `=== BACKEND LOGS ===\n${backendLogs}\n\n=== FRONTEND LOGS ===\n${frontendLogs}`;
      await navigator.clipboard.writeText(allLogs);
      setCopiedBackend(true);
      setCopiedFrontend(true);
      setTimeout(() => {
        setCopiedBackend(false);
        setCopiedFrontend(false);
      }, 2000);
    } catch (err) {
      console.error('Failed to copy logs:', err);
    }
  };

  useEffect(() => {
    if (open) {
      fetchBackendLogs();
      fetchFrontendLogs();
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[1200px] w-[90vw] h-[80vh] max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug className="h-5 w-5" />
            Report a Bug
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground mb-2">These logs may help maintainers debug the issue</div>

        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as 'backend' | 'frontend')}
          className="flex-1 flex flex-col min-h-0"
        >
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <TabsList className="grid w-[280px] grid-cols-2">
              <TabsTrigger value="backend">Backend Logs</TabsTrigger>
              <TabsTrigger value="frontend">Frontend Logs</TabsTrigger>
            </TabsList>
            <Button
              variant="ghost"
              size="sm"
              onClick={activeTab === 'backend' ? fetchBackendLogs : fetchFrontendLogs}
              disabled={activeTab === 'backend' && loading}
              className="flex items-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${activeTab === 'backend' && loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>

          <TabsContent value="backend" className="flex-1 flex flex-col mt-0 min-h-0">
            <div className="flex-1 rounded-md border bg-black/90 overflow-auto min-h-0">
              <div className="p-4">
                {error ? (
                  <div className="text-red-400 font-mono text-sm">Error: {error}</div>
                ) : (
                  <pre className="font-mono text-sm text-green-400 whitespace-pre">{backendLogs}</pre>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="frontend" className="flex-1 flex flex-col mt-0 min-h-0">
            <div className="flex-1 rounded-md border bg-black/90 overflow-auto min-h-0">
              <div className="p-4">
                <pre className="font-mono text-sm text-cyan-400 whitespace-pre">{frontendLogs}</pre>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="flex-row justify-between items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            App Version: {appVersion || 'Unknown'} | Platform: {systemInfo?.platform || 'Unknown'} | OS:{' '}
            {systemInfo?.osVersion || 'Unknown'}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleCopyAllLogs} className="flex items-center gap-2">
              {copiedBackend && copiedFrontend ? (
                <>
                  <CheckCircle className="h-4 w-4 text-green-500" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  Copy All Logs
                </>
              )}
            </Button>
            <Button
              onClick={() => {
                if (onReportBug) {
                  onReportBug();
                }
              }}
              className="flex items-center gap-2"
            >
              <ExternalLink className="h-4 w-4" />
              Proceed to GitHub to report
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
