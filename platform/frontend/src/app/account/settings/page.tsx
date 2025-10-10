"use client";

import {
  AccountSettingsCards,
  OrganizationMembersCard,
  SecuritySettingsCards,
} from "@daveyplate/better-auth-ui";
import { Shield, User, Users } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth-client";

export default function AccountSettingsPage() {
  const { data: session, isPending } = authClient.useSession();
  const { data: activeOrg } = authClient.useActiveOrganization();

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
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="account" className="flex items-center gap-2">
            <User className="h-4 w-4" />
            Account
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Security
          </TabsTrigger>
          <TabsTrigger value="members" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Members
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="mt-6">
          <AccountSettingsCards />
        </TabsContent>

        <TabsContent value="security" className="mt-6">
          <SecuritySettingsCards />
        </TabsContent>

        <TabsContent value="members" className="mt-6">
          {activeOrg ? (
            <OrganizationMembersCard />
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
