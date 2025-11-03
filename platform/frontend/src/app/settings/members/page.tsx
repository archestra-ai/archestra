"use client";

import { OrganizationMembersCard } from "@daveyplate/better-auth-ui";
import { useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { InvitationsList } from "@/components/invitations-list";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { LoadingSpinner } from "@/components/loading";
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
import {
  organizationKeys,
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

function MembersSettingsContent() {
  const queryClient = useQueryClient();
  const { data: activeOrg } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(activeOrg?.id);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const members = activeOrg ? (
    <div className="space-y-6">
      {activeMemberRole &&
        (activeMemberRole === "admin" || activeMemberRole === "owner") && (
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
        action={() => {
          if (activeMemberRole === "admin" || activeMemberRole === "owner") {
            setInviteDialogOpen(true);
          }
        }}
      />
      <InvitationsList key={refreshKey} organizationId={activeOrg.id} />
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
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 w-full">{members}</div>
  );
}

export default function MembersSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <MembersSettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
