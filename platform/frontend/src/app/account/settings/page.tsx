"use client";

import {
  ApiKeysCard,
  DeleteAccountCard,
  OrganizationMembersCard,
  SecuritySettingsCards,
} from "@daveyplate/better-auth-ui";
import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, Users } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  organizationKeys,
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

function SettingsContent() {
  const queryClient = useQueryClient();
  const { data: activeOrg } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(activeOrg?.id);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Periodically check credentials status while on settings page
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({
        queryKey: ["auth", "defaultCredentialsEnabled"],
      });
    }, 2000); // Check every 2 seconds

    return () => clearInterval(interval);
  }, [queryClient]);

  const showMembersTab =
    activeMemberRole &&
    (activeMemberRole === "admin" || activeMemberRole === "owner");

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
    <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
      <div className="mb-6">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Account Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>
      <Tabs defaultValue="account">
        <TabsList
          className={`grid ${showMembersTab ? "grid-cols-2" : "grid-cols-1"}`}
        >
          <TabsTrigger value="account" className="flex items-center gap-2">
            <CircleUser className="h-4 w-4" />
            Your Account
          </TabsTrigger>
          {showMembersTab && (
            <TabsTrigger value="members" className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              Members
            </TabsTrigger>
          )}
        </TabsList>
        <div className="max-w-3xl">
          <TabsContent value="account">
            <div className="space-y-6">
              <SecuritySettingsCards />
              <ApiKeysCard />
              <DeleteAccountCard />
            </div>
          </TabsContent>
          {showMembersTab && (
            <TabsContent value="members">{members}</TabsContent>
          )}
        </div>
      </Tabs>
    </div>
  );
}

export default function AccountSettingsPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SettingsContent />
      </Suspense>
    </ErrorBoundary>
  );
}
