"use client";

import { Loader2, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { authClient } from "@/lib/clients/auth/auth-client";

interface OrganizationMembersCardProps {
  className?: string;
  action?: () => void;
  actionLabel?: string | null;
}

export function OrganizationMembersCard({
  className,
  action,
  actionLabel = "Invite Member",
}: OrganizationMembersCardProps) {
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  const { data: session } = authClient.useSession();
  const { data: members, refetch } = authClient.useListOrganizationMembers({
    query: {
      organizationId: session?.session?.activeOrganizationId || "",
    },
  });

  const handleRemoveMember = async (userId: string) => {
    if (!session?.session?.activeOrganizationId) return;

    setIsDeleting(userId);
    try {
      const result = await authClient.organization.removeMember({
        organizationId: session.session.activeOrganizationId,
        userId,
      });

      if (result.error) {
        console.error("Failed to remove member:", result.error);
      } else {
        refetch();
      }
    } catch (err) {
      console.error("Error removing member:", err);
    } finally {
      setIsDeleting(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Organization Members</CardTitle>
            <CardDescription>
              Manage members of your organization
            </CardDescription>
          </div>
          {action && actionLabel !== null && (
            <Button onClick={action} size="sm">
              <UserPlus className="mr-2 h-4 w-4" />
              {actionLabel}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {members && members.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => (
                <TableRow key={member.userId}>
                  <TableCell className="font-medium">
                    {member.user?.name || "—"}
                  </TableCell>
                  <TableCell>{member.user?.email}</TableCell>
                  <TableCell className="capitalize">{member.role}</TableCell>
                  <TableCell className="text-right">
                    {member.userId !== session?.user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMember(member.userId)}
                        disabled={isDeleting === member.userId}
                      >
                        {isDeleting === member.userId ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <UserPlus className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-sm text-muted-foreground">
              No members yet. Invite someone to get started.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
