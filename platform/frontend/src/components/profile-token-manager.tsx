"use client";

import { Key, MoreHorizontal, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useProfileTokens,
  useRotateProfileToken,
} from "@/lib/profile-token.query";
import { LoadingSpinner } from "./loading";

interface ProfileTokenManagerProps {
  profileId: string;
}

export function ProfileTokenManager({ profileId }: ProfileTokenManagerProps) {
  const { data: tokens, isLoading } = useProfileTokens(profileId);
  const rotateToken = useRotateProfileToken();

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

  const formatDate = (date: string | null) => {
    if (!date) return "Never";
    return new Date(date).toLocaleDateString();
  };

  if (isLoading) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium">Access Tokens</h4>
        <p className="text-xs text-muted-foreground">
          Tokens for authenticating with the MCP Gateway. Tokens are
          automatically managed based on team assignments.
        </p>
      </div>

      {tokens && tokens.length > 0 ? (
        <div className="border rounded-md">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Scope</TableHead>
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
                      <Badge variant="secondary">Whole Organization</Badge>
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
          No tokens available. Tokens will be created automatically when the
          profile is assigned to teams.
        </div>
      )}
    </div>
  );
}
