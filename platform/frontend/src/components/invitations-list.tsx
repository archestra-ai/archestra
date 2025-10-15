"use client";

import { QueryErrorResetBoundary, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  ChevronDown,
  Copy,
  Mail,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  organizationKeys,
  useCancelInvitation,
  useInvitationsList,
  useReinvite,
} from "@/lib/organization.query";

interface Invitation {
  id: string;
  email: string;
  role?: string;
  expiresAt?: string | null;
  createdAt?: string | null;
  isExpired?: boolean;
  status?: "pending" | "accepted" | "rejected";
}

function InvitationsListContent({
  organizationId,
  showAllStatuses = false,
}: {
  organizationId?: string;
  showAllStatuses?: boolean;
}) {
  const queryClient = useQueryClient();
  const { data: invitations } = useInvitationsList(
    organizationId,
    showAllStatuses,
  );
  const cancelMutation = useCancelInvitation(organizationId);
  const reinviteMutation = useReinvite(organizationId);
  const [isRejectedOpen, setIsRejectedOpen] = useState(false);

  const handleCopy = async (id: string) => {
    const link = `${window.location.origin}/accept-invitation/${id}`;
    await navigator.clipboard.writeText(link);
    toast.success("Link copied to clipboard");
  };

  const handleDelete = async (invitationId: string) => {
    await cancelMutation.mutateAsync(invitationId);
    queryClient.invalidateQueries({ queryKey: organizationKeys.invitations() });
  };

  const handleReinvite = async (email: string, oldInvitationId: string) => {
    await reinviteMutation.mutateAsync({ email, oldInvitationId });
    queryClient.invalidateQueries({ queryKey: organizationKeys.invitations() });
  };

  const pendingInvitations = invitations.filter(
    (inv) => inv.status === "pending" && !inv.isExpired,
  );
  const rejectedInvitations = invitations.filter(
    (inv) => inv.status === "rejected",
  );

  const isProcessing = cancelMutation.isPending || reinviteMutation.isPending;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>
          {showAllStatuses ? "All Invitations" : "Pending Invitations"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {invitations.length === 0 && (
          <div className="text-sm text-muted-foreground">
            No invitations found
          </div>
        )}

        {/* Pending Invitations */}
        {pendingInvitations.length > 0 && (
          <div className="space-y-3">
            {showAllStatuses && (
              <div className="text-sm font-medium text-foreground">Pending</div>
            )}
            {pendingInvitations.map((inv) => (
              <div
                key={inv.id}
                className="flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Mail className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm truncate">{inv.email}</p>
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
                    disabled={isProcessing}
                    title="Cancel invitation"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Rejected Invitations */}
        {showAllStatuses && rejectedInvitations.length > 0 && (
          <Collapsible open={isRejectedOpen} onOpenChange={setIsRejectedOpen}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full hover:opacity-70 transition-opacity">
              <ChevronDown
                className={`h-4 w-4 transition-transform ${isRejectedOpen ? "" : "-rotate-90"}`}
              />
              <div className="text-sm font-medium text-muted-foreground">
                Rejected ({rejectedInvitations.length})
              </div>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 mt-3">
              {rejectedInvitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
                    <XCircle className="h-5 w-5 text-muted-foreground" />
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
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleReinvite(inv.email, inv.id)}
                      disabled={isProcessing}
                      title="Send new invitation"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </CardContent>
    </Card>
  );
}

export function InvitationsList({
  organizationId,
  showAllStatuses = false,
}: {
  organizationId?: string;
  showAllStatuses?: boolean;
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
                  {error?.message || "Failed to load invitations"}
                </p>
                <Button onClick={resetErrorBoundary} variant="outline">
                  Try Again
                </Button>
              </CardContent>
            </Card>
          )}
        >
          <Suspense fallback={<LoadingSpinner />}>
            <InvitationsListContent
              organizationId={organizationId}
              showAllStatuses={showAllStatuses}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
