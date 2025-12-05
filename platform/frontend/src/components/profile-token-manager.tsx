"use client";

import { Key, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelect } from "@/components/ui/multi-select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCreateProfileToken,
  useDeleteProfileToken,
  useProfileTokens,
  useRotateProfileToken,
} from "@/lib/profile-token.query";
import { useTeams } from "@/lib/team.query";
import { LoadingSpinner } from "./loading";

interface ProfileTokenManagerProps {
  profileId: string;
}

export function ProfileTokenManager({ profileId }: ProfileTokenManagerProps) {
  const { data: tokens, isLoading } = useProfileTokens(profileId);
  const { data: teams } = useTeams();
  const createToken = useCreateProfileToken();
  const deleteToken = useDeleteProfileToken();
  const rotateToken = useRotateProfileToken();

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenTeams, setNewTokenTeams] = useState<string[]>([]);
  const [isOrganizationToken, setIsOrganizationToken] = useState(false);

  const teamOptions = (teams ?? []).map((team) => ({
    value: team.id,
    label: team.name,
  }));

  const handleCreateToken = async () => {
    if (!newTokenName.trim()) {
      toast.error("Token name is required");
      return;
    }

    const result = await createToken.mutateAsync({
      profileId,
      data: {
        name: newTokenName.trim(),
        teamIds: isOrganizationToken ? [] : newTokenTeams,
        isOrganizationToken,
      },
    });

    if (result?.value) {
      await navigator.clipboard.writeText(result.value);
      toast.success("Token created and copied to clipboard");
      handleCloseCreateDialog();
    }
  };

  const handleDeleteToken = async (tokenId: string, tokenName: string) => {
    await deleteToken.mutateAsync({ profileId, tokenId, tokenName });
  };

  const handleRotateToken = async (tokenId: string) => {
    const result = await rotateToken.mutateAsync({
      profileId,
      tokenId,
    });
    if (result?.value) {
      await navigator.clipboard.writeText(result.value);
      toast.success("Token rotated and copied to clipboard");
    }
  };

  const handleCloseCreateDialog = () => {
    setCreateDialogOpen(false);
    setNewTokenName("");
    setNewTokenTeams([]);
    setIsOrganizationToken(false);
  };

  const formatDate = (date: string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString();
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-medium">Access Tokens</h4>
          <p className="text-xs text-muted-foreground">
            Tokens for authenticating with the MCP Gateway
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreateDialogOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Token
        </Button>
      </div>

      {tokens && tokens.length > 0 ? (
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Teams</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-muted-foreground" />
                      {token.name}
                    </div>
                  </TableCell>
                  <TableCell>
                    {token.isOrganizationToken ? (
                      <Badge variant="secondary">All Teams</Badge>
                    ) : token.teams && token.teams.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {token.teams.map((team) => (
                          <Badge key={team.id} variant="outline">
                            {team.name}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-sm">
                        No teams
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      {token.tokenStart}...
                    </code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(token.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => handleRotateToken(token.id)}
                        >
                          <RefreshCw className="h-4 w-4 mr-2" />
                          Rotate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() =>
                            handleDeleteToken(token.id, token.name)
                          }
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border rounded-md p-4 text-center text-sm text-muted-foreground">
          No tokens yet. Create one to get started.
        </div>
      )}

      <Dialog open={createDialogOpen} onOpenChange={handleCloseCreateDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Create Access Token</DialogTitle>
            <DialogDescription>
              Create a new token for MCP Gateway authentication.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tokenName">Name</Label>
              <Input
                id="tokenName"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="e.g., Development, CI/CD"
              />
            </div>

            <div className="flex items-center space-x-2">
              <Switch
                id="orgToken"
                checked={isOrganizationToken}
                onCheckedChange={setIsOrganizationToken}
              />
              <Label htmlFor="orgToken">Organization-wide token</Label>
            </div>

            {!isOrganizationToken && (
              <div className="space-y-2">
                <Label>Teams</Label>
                <MultiSelect
                  value={newTokenTeams}
                  onValueChange={setNewTokenTeams}
                  items={teamOptions}
                  placeholder="Select teams..."
                />
                <p className="text-xs text-muted-foreground">
                  Select which teams this token can access credentials for.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseCreateDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateToken}
              disabled={createToken.isPending}
            >
              {createToken.isPending ? "Creating..." : "Create Token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
