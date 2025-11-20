"use client";

import { ADMIN_ROLE_NAME, type AnyRoleName, MEMBER_ROLE_NAME } from "@shared";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Check, Copy, Link as LinkIcon, Loader2 } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateInvitation } from "@/lib/organization.query";
import { useRoles } from "@/lib/role.query";

interface InviteByLinkCardProps {
  organizationId?: string;
  onInvitationCreated?: () => void;
}

function InviteByLinkCardContent({
  organizationId,
  onInvitationCreated,
}: InviteByLinkCardProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AnyRoleName>(MEMBER_ROLE_NAME);
  const [invitationLink, setInvitationLink] = useState("");
  const [isCopied, setIsCopied] = useState(false);

  const createMutation = useCreateInvitation(organizationId);
  const { data: roles } = useRoles();

  // Validate email format
  const isValidEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleGenerateLink = useCallback(async () => {
    const data = await createMutation.mutateAsync({ email, role });

    if (data) {
      const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${data.id}&email=${encodeURIComponent(email)}`;
      setInvitationLink(link);
      onInvitationCreated?.();
    }
  }, [email, role, createMutation, onInvitationCreated]);

  const handleCopyLink = useCallback(async () => {
    if (!invitationLink) return;

    await navigator.clipboard.writeText(invitationLink);
    setIsCopied(true);
    toast.success("Link copied", {
      description: "Invitation link copied to clipboard",
    });

    setTimeout(() => setIsCopied(false), 2000);
  }, [invitationLink]);

  const handleReset = useCallback(() => {
    setEmail("");
    setRole(MEMBER_ROLE_NAME);
    setInvitationLink("");
    setIsCopied(false);
  }, []);

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LinkIcon className="h-5 w-5" />
          Invite Member by Link
        </CardTitle>
        <CardDescription>
          Generate an invitation link to share with the person you want to
          invite to your organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!invitationLink ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="user@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={createMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">
                The email of the person you want to invite
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select
                value={role}
                onValueChange={(value: AnyRoleName) => setRole(value)}
                disabled={createMutation.isPending}
              >
                <SelectTrigger id="role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ADMIN_ROLE_NAME}>Admin</SelectItem>
                  <SelectItem value={MEMBER_ROLE_NAME}>Member</SelectItem>
                  {roles
                    ?.filter((r) => !r.predefined)
                    .map((r) => (
                      <SelectItem key={r.id} value={r.name}>
                        {r.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The role this person will have in your organization
              </p>
            </div>

            <PermissionButton
              permissions={{ invitation: ["create"] }}
              onClick={handleGenerateLink}
              disabled={createMutation.isPending || !isValidEmail}
              className="w-full"
            >
              {createMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Generate Invitation Link
            </PermissionButton>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Invitation Link</Label>
              <div className="flex items-center gap-2">
                <Input value={invitationLink} readOnly className="flex-1" />
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={handleCopyLink}
                >
                  {isCopied ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this link with{" "}
                <span className="font-medium">{email}</span> to invite them as a{" "}
                <span className="font-medium">{role}</span>
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleReset}
                variant="outline"
                className="flex-1"
              >
                Create Another
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function InviteByLinkCard({
  organizationId,
  onInvitationCreated,
}: InviteByLinkCardProps) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallbackRender={({ error, resetErrorBoundary }) => (
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="text-destructive">
                  Error Creating Invitation
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  {error?.message || "Failed to create invitation"}
                </p>
                <Button onClick={resetErrorBoundary} variant="outline">
                  Try Again
                </Button>
              </CardContent>
            </Card>
          )}
        >
          <Suspense fallback={<LoadingSpinner />}>
            <InviteByLinkCardContent
              organizationId={organizationId}
              onInvitationCreated={onInvitationCreated}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
