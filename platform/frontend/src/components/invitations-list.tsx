"use client";

import { QueryErrorResetBoundary, useQueryClient } from "@tanstack/react-query";
import { Copy, Mail, Trash2 } from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { toast } from "sonner";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PermissionButton } from "@/components/ui/permission-button";
import { TooltipButton } from "@/components/ui/tooltip-button";
import {
  organizationKeys,
  useCancelInvitation,
  useInvitationsList,
} from "@/lib/organization.query";

function InvitationsListContent({
  organizationId,
}: {
  organizationId?: string;
}) {
  const queryClient = useQueryClient();
  const { data: invitations = [], isPending } =
    useInvitationsList(organizationId);
  const cancelMutation = useCancelInvitation();

  const handleCopy = async (id: string, email: string) => {
    const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${id}&email=${encodeURIComponent(email)}`;
    await navigator.clipboard.writeText(link);
    toast.success("Link copied to clipboard");
  };

  const handleDelete = async (invitationId: string) => {
    await cancelMutation.mutateAsync(invitationId);
    queryClient.invalidateQueries({ queryKey: organizationKeys.invitations() });
  };

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Pending Invitations</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {invitations.length === 0 && (
            <div className="text-sm text-muted-foreground">
              No pending invitations
            </div>
          )}

          {invitations.length > 0 && (
            <div className="space-y-3">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <Mail className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium text-sm truncate">
                        {inv.email}
                      </p>
                      <Badge
                        variant="outline"
                        className="text-xs text-muted-foreground"
                      >
                        {inv.role}
                      </Badge>
                    </div>
                    <div className="space-y-0.5">
                      {inv.expiresAt && (
                        <p className="text-xs text-muted-foreground">
                          Expires {new Date(inv.expiresAt).toLocaleDateString()}{" "}
                          at {new Date(inv.expiresAt).toLocaleTimeString()}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <TooltipButton
                      tooltip="Copy invitation link"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleCopy(inv.id, inv.email)}
                    >
                      <Copy className="h-4 w-4" />
                    </TooltipButton>
                    <PermissionButton
                      permissions={{ invitation: ["cancel"] }}
                      tooltip="Delete invitation"
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(inv.id)}
                      disabled={cancelMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </PermissionButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </LoadingWrapper>
  );
}

export function InvitationsList({
  organizationId,
}: {
  organizationId?: string;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallbackRender={({ error, resetErrorBoundary }) => (
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="text-destructive">
                  Error Loading Invitations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  {error instanceof Error
                    ? error.message
                    : "Failed to load invitations"}
                </p>
                <Button onClick={resetErrorBoundary} variant="outline">
                  Try Again
                </Button>
              </CardContent>
            </Card>
          )}
        >
          <InvitationsListContent organizationId={organizationId} />
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
