"use client";

import {
  Check,
  Copy,
  Key,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
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

  const [newTokenValue, setNewTokenValue] = useState<string | null>(null);
  const [copiedTokenValue, setCopiedTokenValue] = useState(false);

  const teamOptions = (teams ?? []).map((team) => ({
    value: team.id,
    label: team.name,
  }));

  const handleCreateToken = async () => {
    if (!newTokenName.trim()) {
      toast.error("Token name is required");
      return;
    }

    try {
      const result = await createToken.mutateAsync({
        profileId,
        data: {
          name: newTokenName.trim(),
          teamIds: isOrganizationToken ? [] : newTokenTeams,
          isOrganizationToken,
        },
      });

      if (result?.value) {
        setNewTokenValue(result.value);
      }
      toast.success("Token created successfully");
    } catch {
      toast.error("Failed to create token");
    }
  };

  const handleDeleteToken = async (tokenId: string, tokenName: string) => {
    try {
      await deleteToken.mutateAsync({ profileId, tokenId });
      toast.success(`Token "${tokenName}" deleted`);
    } catch {
      toast.error("Failed to delete token");
    }
  };

  const handleRotateToken = async (tokenId: string, tokenName: string) => {
    try {
      const result = await rotateToken.mutateAsync({ profileId, tokenId });
      if (result?.value) {
        setNewTokenValue(result.value);
        setCreateDialogOpen(true);
      }
      toast.success(`Token "${tokenName}" rotated`);
    } catch {
      toast.error("Failed to rotate token");
    }
  };

  const handleCopyTokenValue = useCallback(async () => {
    if (!newTokenValue) return;
    await navigator.clipboard.writeText(newTokenValue);
    setCopiedTokenValue(true);
    toast.success("Token copied to clipboard");
    setTimeout(() => setCopiedTokenValue(false), 2000);
  }, [newTokenValue]);

  const handleCloseCreateDialog = () => {
    setCreateDialogOpen(false);
    setNewTokenName("");
    setNewTokenTeams([]);
    setIsOrganizationToken(false);
    setNewTokenValue(null);
  };

  const formatDate = (date: string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground">Loading tokens...</div>
    );
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
                          onClick={() =>
                            handleRotateToken(token.id, token.name)
                          }
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {newTokenValue ? "Token Created" : "Create Access Token"}
            </DialogTitle>
            <DialogDescription>
              {newTokenValue
                ? "Copy your new token now. You won't be able to see it again."
                : "Create a new token for MCP Gateway authentication."}
            </DialogDescription>
          </DialogHeader>

          {newTokenValue ? (
            <div className="space-y-4">
              <div className="bg-muted rounded-md p-3 flex items-center justify-between">
                <code className="text-sm break-all flex-1 mr-2">
                  {newTokenValue}
                </code>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCopyTokenValue}
                >
                  {copiedTokenValue ? (
                    <Check className="h-4 w-4 text-green-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Store this token securely. It provides access to the MCP Gateway
                for this profile.
              </p>
            </div>
          ) : (
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
          )}

          <DialogFooter>
            {newTokenValue ? (
              <Button onClick={handleCloseCreateDialog}>Done</Button>
            ) : (
              <>
                <Button variant="outline" onClick={handleCloseCreateDialog}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateToken}
                  disabled={createToken.isPending}
                >
                  {createToken.isPending ? "Creating..." : "Create Token"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
