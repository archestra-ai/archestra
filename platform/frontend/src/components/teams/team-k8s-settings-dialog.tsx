"use client";

import { Server } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useFeature } from "@/lib/config/config.query";
import { useUpdateTeamK8sSettings } from "@/lib/teams/team.query";

interface Team {
  id: string;
  name: string;
  k8sNamespace?: string | null;
  k8sKubeconfigBase64?: string | null;
}

interface TeamK8sSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team;
}

/**
 * Dialog for configuring per-team Kubernetes namespace and cluster overrides.
 *
 * When set, MCP servers belonging to this team will be deployed to the
 * configured namespace / cluster instead of the org-wide or global defaults.
 */
export function TeamK8sSettingsDialog({
  open,
  onOpenChange,
  team,
}: TeamK8sSettingsDialogProps) {
  const orchestratorEnabled = useFeature("orchestratorK8sRuntime");
  const [namespace, setNamespace] = useState(team.k8sNamespace ?? "");
  const [kubeconfigBase64, setKubeconfigBase64] = useState(
    team.k8sKubeconfigBase64 ?? "",
  );

  const updateMutation = useUpdateTeamK8sSettings(team.id);

  // Reset form when dialog opens / team changes
  useEffect(() => {
    if (open) {
      setNamespace(team.k8sNamespace ?? "");
      setKubeconfigBase64(team.k8sKubeconfigBase64 ?? "");
    }
  }, [open, team]);

  if (!orchestratorEnabled) return null;

  const handleSave = async () => {
    await updateMutation.mutateAsync({
      k8sNamespace: namespace.trim() || null,
      k8sKubeconfigBase64: kubeconfigBase64.trim() || null,
    });
    onOpenChange(false);
  };

  const handleClear = async () => {
    await updateMutation.mutateAsync({
      k8sNamespace: null,
      k8sKubeconfigBase64: null,
    });
    setNamespace("");
    setKubeconfigBase64("");
    onOpenChange(false);
  };

  const hasOverrides = !!(team.k8sNamespace || team.k8sKubeconfigBase64);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            Kubernetes Settings — {team.name}
          </DialogTitle>
          <DialogDescription>
            Override the Kubernetes namespace or cluster used when deploying MCP
            servers for this team. Leave blank to inherit the org-wide or global
            default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="k8s-namespace">Namespace</Label>
            <Input
              id="k8s-namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="e.g. team-alpha-mcp"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Kubernetes namespace for MCP server pods belonging to this team.
              Falls back to the org-wide setting when blank.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="k8s-kubeconfig">KUBECONFIG (base64)</Label>
            <Textarea
              id="k8s-kubeconfig"
              value={kubeconfigBase64}
              onChange={(e) => setKubeconfigBase64(e.target.value)}
              placeholder="Paste base64-encoded KUBECONFIG here to use a separate cluster"
              rows={5}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Encode your kubeconfig:{" "}
              <code className="text-xs">base64 -w 0 ~/.kube/config</code>
              <br />
              Leave blank to use the same cluster as the rest of the
              organization.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {hasOverrides && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClear}
                disabled={updateMutation.isPending}
                className="text-destructive hover:text-destructive"
              >
                Clear overrides
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
