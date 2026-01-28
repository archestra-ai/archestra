"use client";

import { OrganizationMembersCard } from "@daveyplate/better-auth-ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { InvitationsList } from "@/components/invitations-list";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import config from "@/lib/config";
import {
  organizationKeys,
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

function MembersSettingsContent() {
  const queryClient = useQueryClient();
  const { data: activeOrg, isPending } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(activeOrg?.id);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const hasPermissionTodo = "TODO:";
  const invitationsEnabled = !config.disableInvitations;

  const members = activeOrg ? (
    <div className="space-y-6">
      {invitationsEnabled && activeMemberRole && hasPermissionTodo && (
        <Dialog
          open={inviteDialogOpen}
          onOpenChange={(open) => {
            setInviteDialogOpen(open);
            if (!open) {
              queryClient.invalidateQueries({
                queryKey: organizationKeys.invitations(),
              });
            }
          }}
        >
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>Invite Member</DialogTitle>
            </DialogHeader>
            <InviteByLinkCard
              organizationId={activeOrg.id}
              onInvitationCreated={() => setRefreshKey((prev) => prev + 1)}
            />
          </DialogContent>
        </Dialog>
      )}
      <OrganizationMembersCard
        {...(!invitationsEnabled && {
          actionLabel: null,
          instructions: null,
        })}
        action={
          invitationsEnabled
            ? () => {
                setInviteDialogOpen(true);
              }
            : undefined
        }
      />
      {invitationsEnabled && (
        <InvitationsList key={refreshKey} organizationId={activeOrg.id} />
      )}
    </div>
  ) : (
    <Card>
      <CardHeader>
        <CardTitle>No Organization</CardTitle>
        <CardDescription>
          You are not part of any organization yet.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          An organization will be created for you automatically. Please refresh
          the page or sign out and sign in again.
        </p>
      </CardContent>
    </Card>
  );

  return (
    <LoadingWrapper isPending={isPending} loadingFallback={<LoadingSpinner />}>
      {members}
    </LoadingWrapper>
  );
}

export default function MembersSettingsPage() {
  return (
    <ErrorBoundary>
      <MembersSettingsContent />
    </ErrorBoundary>
  );
}
