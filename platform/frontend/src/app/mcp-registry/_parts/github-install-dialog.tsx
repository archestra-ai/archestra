"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GetMcpCatalogResponses } from "@/lib/clients/api";

interface GitHubInstallDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onInstall: (
    catalogItem: GetMcpCatalogResponses["200"][number],
    metadata: Record<string, unknown>,
  ) => Promise<void>;
  catalogItem: GetMcpCatalogResponses["200"][number] | null;
  isInstalling: boolean;
}

export function GitHubInstallDialog({
  isOpen,
  onClose,
  onInstall,
  catalogItem,
  isInstalling,
}: GitHubInstallDialogProps) {
  const [githubToken, setGithubToken] = useState("");

  const handleInstall = useCallback(async () => {
    if (!catalogItem || !githubToken.trim()) {
      return;
    }

    try {
      await onInstall(catalogItem, { githubToken: githubToken.trim() });
      setGithubToken("");
      onClose();
    } catch (_error) {
      // Error handling is done in the parent component
    }
  }, [catalogItem, githubToken, onInstall, onClose]);

  const handleClose = useCallback(() => {
    setGithubToken("");
    onClose();
  }, [onClose]);

  if (!catalogItem) {
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Install {catalogItem.name}</DialogTitle>
          <DialogDescription>
            This MCP server requires a GitHub Personal Access Token to access
            repositories.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="github-token">GitHub Personal Access Token</Label>
            <Input
              id="github-token"
              type="password"
              placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              className="col-span-3"
            />
            <p className="text-sm text-muted-foreground">
              You can create a Personal Access Token in your GitHub settings.
              Make sure it has appropriate repository permissions for the
              repositories you want to access.
            </p>
          </div>

          <div className="rounded-md bg-muted p-4">
            <h4 className="text-sm font-medium mb-2">Required Permissions:</h4>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>• Repository access (read/write)</li>
              <li>• Issues and pull requests</li>
              <li>• Repository contents</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            Cancel
          </Button>
          <Button
            onClick={handleInstall}
            disabled={!githubToken.trim() || isInstalling}
          >
            {isInstalling ? "Installing..." : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
