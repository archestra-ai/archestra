"use client";

import { Copy, Mail, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

interface Invitation {
  id: string;
  email: string;
  role?: string;
  expiresAt?: string | null;
  isExpired?: boolean;
}

export function InvitePendingList({
  organizationId,
}: {
  organizationId?: string;
}) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const fetchInvitations = useCallback(async () => {
    if (!organizationId) return;
    setIsLoading(true);
    try {
      const { data, error } = await authClient.organization.listInvitations({
        query: { organizationId },
      });

      if (error) {
        toast.error("Failed to load invitations", {
          description: error.message,
        });
        return;
      }

      if (data) {
        const now = new Date();
        const list = data
          .filter((inv: any) => inv.status === "pending")
          .map((inv: any) => {
            const expiresAt = inv.expiresAt || null;
            const isExpired = expiresAt ? new Date(expiresAt) < now : false;

            return {
              id: inv.id,
              email: inv.email,
              role: inv.role || "member",
              expiresAt,
              isExpired,
            };
          })
          .sort((a, b) => {
            if (a.isExpired !== b.isExpired) {
              return a.isExpired ? 1 : -1;
            }
            return 0;
          });
        setInvitations(list);
      }
    } catch (_err) {
      toast.error("Failed to load invitations");
    } finally {
      setIsLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    fetchInvitations();
  }, [organizationId, fetchInvitations]);

  const handleCopy = async (id: string) => {
    const link = `${window.location.origin}/accept-invitation/${id}`;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied to clipboard");
    } catch (_err) {
      toast.error("Failed to copy link");
    }
  };

  const handleDelete = async (invitationId: string) => {
    setDeletingIds((prev) => new Set(prev).add(invitationId));
    try {
      const { error } = await authClient.organization.cancelInvitation({
        invitationId,
      });

      if (error) {
        toast.error("Failed to cancel invitation", {
          description: error.message,
        });
        return;
      }

      toast.success("Invitation cancelled");
      // Refresh the list
      await fetchInvitations();
    } catch (_err) {
      toast.error("Failed to cancel invitation");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(invitationId);
        return next;
      });
    }
  };

  const handleReinvite = async (email: string, oldInvitationId: string) => {
    setDeletingIds((prev) => new Set(prev).add(oldInvitationId));
    try {
      await authClient.organization.cancelInvitation({
        invitationId: oldInvitationId,
      });

      const { data, error } = await authClient.organization.inviteMember({
        email,
        role: "member",
        organizationId,
      });

      if (error) {
        toast.error("Failed to create new invitation", {
          description: error.message,
        });
        return;
      }

      if (data) {
        toast.success("New invitation created", {
          description: `A fresh invitation link has been generated for ${email}`,
        });
        // Refresh the list
        await fetchInvitations();
      }
    } catch (_err) {
      toast.error("Failed to reinvite");
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(oldInvitationId);
        return next;
      });
    }
  };

  const activeInvitations = invitations.filter((inv) => !inv.isExpired);
  const expiredInvitations = invitations.filter((inv) => inv.isExpired);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Pending Invitations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="text-sm text-muted-foreground">Loading...</div>
        )}
        {!isLoading && invitations.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No pending invitations
          </div>
        )}

        {/* Active Invitations */}
        {activeInvitations.length > 0 && (
          <div className="space-y-3">
            {activeInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Mail className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm truncate">{inv.email}</p>
                    <Badge variant="secondary" className="text-xs">
                      {inv.role}
                    </Badge>
                  </div>
                  {inv.expiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Expires {new Date(inv.expiresAt).toLocaleDateString()} at{" "}
                      {new Date(inv.expiresAt).toLocaleTimeString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleCopy(inv.id)}
                    title="Copy invitation link"
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(inv.id)}
                    disabled={deletingIds.has(inv.id)}
                    title="Cancel invitation"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Expired Invitations */}
        {expiredInvitations.length > 0 && (
          <div className="space-y-3">
            <div className="text-sm font-medium text-muted-foreground">
              Expired Invitations
            </div>
            {expiredInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30 opacity-75"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm truncate">{inv.email}</p>
                    <Badge variant="secondary" className="text-xs">
                      {inv.role}
                    </Badge>
                    <Badge variant="destructive" className="text-xs">
                      Expired
                    </Badge>
                  </div>
                  {inv.expiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Expired on {new Date(inv.expiresAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleReinvite(inv.email, inv.id)}
                    disabled={deletingIds.has(inv.id)}
                    title="Send new invitation"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(inv.id)}
                    disabled={deletingIds.has(inv.id)}
                    title="Remove invitation"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
