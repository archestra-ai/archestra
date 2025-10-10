"use client";

import {
  AccountSettingsCards,
  OrganizationMembersCard,
  SecuritySettingsCards,
} from "@daveyplate/better-auth-ui";
import { Shield, User, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { InviteByLinkCard } from "@/components/invite-by-link-card";
import { InvitePendingList } from "@/components/invite-pending-list";
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
import { authClient } from "@/lib/auth-client";

export default function AccountSettingsPage() {
  const { data: session, isPending } = authClient.useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();
  const [activeMemberRole, setActiveMemberRole] = useState<string | null>(null);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [_refreshKey, _setRefreshKey] = useState(0);

  const fetchRole = useCallback(async () => {
    if (!activeOrg?.id) return;
    try {
      const { data } = await authClient.organization.getActiveMemberRole();
      const role =
        data && typeof data === "object" && "role" in data
          ? (data as any).role
          : (data as any);
      setActiveMemberRole(role || null);
    } catch (_err) {
      setActiveMemberRole(null);
    }
  }, [activeOrg?.id]);

  useEffect(() => {
    fetchRole();
  }, [fetchRole]);

  if (isPending) {
    return (
      <main className="container p-4 md:p-6">
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </main>
    );
  }

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
          <AccountSettingsCards />
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
