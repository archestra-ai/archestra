"use client";

import {
  AccountSettingsCards,
  DeleteAccountCard,
  OrganizationMembersCard,
  SecuritySettingsCards,
} from "@daveyplate/better-auth-ui";
import { Shield, User, Users } from "lucide-react";
import { Suspense, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { InvitePendingList } from "@/components/invite-pending-list";
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
  useActiveMemberRole,
  useActiveOrganization,
} from "@/lib/organization.query";

function SettingsContent() {
  const { data: activeOrg } = useActiveOrganization();
  const { data: activeMemberRole } = useActiveMemberRole(activeOrg?.id);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <main className="container p-4 md:p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold">Account Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences
        </p>
      </div>

      <Tabs defaultValue="account" className="w-full">
        <TabsList
          className={`grid w-full ${activeMemberRole && (activeMemberRole === "admin" || activeMemberRole === "owner") ? "grid-cols-3" : "grid-cols-2"}`}
        >
          <TabsTrigger value="account" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Account
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
          {activeMemberRole &&
            (activeMemberRole === "admin" || activeMemberRole === "owner") && (
              <TabsTrigger value="members" className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                Members
              </TabsTrigger>
            )}
        </TabsList>

        <TabsContent value="account" className="mt-6">
          <div className="space-y-6">
            <AccountSettingsCards />
            <DeleteAccountCard />
          </div>
        </TabsContent>

        <TabsContent value="security" className="mt-6">
          <SecuritySettingsCards />
        </TabsContent>

        <TabsContent value="members" className="mt-6">
          {activeOrg ? (
            <div className="space-y-6">
              {activeMemberRole &&
                (activeMemberRole === "admin" ||
                  activeMemberRole === "owner") && (
                  <Dialog
                    open={inviteDialogOpen}
                    onOpenChange={setInviteDialogOpen}
                  >
                    <DialogContent className="sm:max-w-[500px]">
                      <DialogHeader>
                        <DialogTitle>Invite Member</DialogTitle>
                      </DialogHeader>
                      <InviteByLinkCard
                        organizationId={activeOrg.id}
                        onInvitationCreated={() =>
                          setRefreshKey((prev) => prev + 1)
                        }
                      />
                      <InvitePendingList
                        key={refreshKey}
                        organizationId={activeOrg.id}
                      />
                    </DialogContent>
                  </Dialog>
                )}
              <OrganizationMembersCard
                action={() => {
                  if (
                    activeMemberRole === "admin" ||
                    activeMemberRole === "owner"
                  ) {
                    setInviteDialogOpen(true);
                  }
                }}
              />
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
                  An organization will be created for you automatically. Please
                  refresh the page or sign out and sign in again.
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </main>
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
