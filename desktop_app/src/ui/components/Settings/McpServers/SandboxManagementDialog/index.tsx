import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Alert, AlertDescription } from '@ui/components/ui/alert';
import { Button } from '@ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ui/components/ui/dialog';
import { resetSandbox, restartSandbox } from '@ui/lib/clients/archestra/api/gen';
import { useMcpServersStore } from '@ui/stores';

interface SandboxManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SandboxManagementDialog({ open, onOpenChange }: SandboxManagementDialogProps) {
  const [isRestarting, setIsRestarting] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { resetInstalledMcpServers } = useMcpServersStore();

  const handleRestart = useCallback(async () => {
    setIsRestarting(true);
    setError(null);
    try {
      await restartSandbox();
      resetInstalledMcpServers();

      // Close dialog on success - the sandbox will restart and update via WebSocket
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to restart the sandbox');
    } finally {
      setIsRestarting(false);
    }
  }, []);

  const handleReset = useCallback(async () => {
    setIsResetting(true);
    setError(null);
    try {
      await resetSandbox();
      resetInstalledMcpServers();

      // Close both dialogs on success
      setShowResetConfirmation(false);
      onOpenChange(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to reset the sandbox');
    } finally {
      setIsResetting(false);
    }
  }, []);

  if (showResetConfirmation) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Confirm Reset
            </DialogTitle>
            <DialogDescription>
              Are you absolutely sure you want to reset the sandbox? This action cannot be undone. <br />
              <br />
              <b>Note:</b> depending on how many MCP servers you have installed, this can take a bit of time.
            </DialogDescription>
          </DialogHeader>

          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              This will permanently delete all installed MCP servers and their configurations. You will need to
              reinstall any servers you want to use.
            </AlertDescription>
          </Alert>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              className="cursor-pointer"
              onClick={() => setShowResetConfirmation(false)}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button variant="destructive" className="cursor-pointer" onClick={handleReset} disabled={isResetting}>
              {isResetting ? 'Resetting...' : 'Yes, Reset Everything'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sandbox Management</DialogTitle>
          <DialogDescription>Manage your Archestra MCP Sandbox environment</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Restart Sandbox Option */}
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <RefreshCw className="h-5 w-5 mt-0.5 text-blue-500" />
              <div className="flex-1">
                <h3 className="font-medium">Restart Sandbox</h3>
                <p className="text-sm text-muted-foreground">
                  Restart the Podman machine and all installed MCP servers. Use this if you're experiencing connection
                  issues or need a fresh start without losing your configurations.
                </p>
                <Button
                  className="mt-3 cursor-pointer"
                  variant="default"
                  onClick={handleRestart}
                  disabled={isRestarting || isResetting}
                >
                  {isRestarting ? 'Restarting...' : 'Restart Sandbox'}
                </Button>
              </div>
            </div>
          </div>

          <div className="border-t" />

          {/* Clean/Purge Data Option */}
          <div className="space-y-2">
            <div className="flex items-start gap-3">
              <Trash2 className="h-5 w-5 mt-0.5 text-destructive" />
              <div className="flex-1">
                <h3 className="font-medium">Clean / Purge Data</h3>
                <p className="text-sm text-muted-foreground">
                  Completely reset the sandbox by uninstalling all MCP servers and resetting the Podman machine. This
                  will remove all server configurations and require you to reinstall any servers you need.
                </p>
                <Button
                  className="mt-3 cursor-pointer"
                  variant="destructive"
                  onClick={() => setShowResetConfirmation(true)}
                  disabled={isRestarting || isResetting}
                >
                  {isResetting ? 'Resetting...' : 'Clean / Purge Data'}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
