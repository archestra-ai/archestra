"use client";

import { type AnyRoleName, E2eTestId, MEMBER_ROLE_NAME } from "@shared";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { Check, Copy, Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogForm, DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import { RoleSelect } from "@/components/ui/role-select";
import { useCreateInvitation } from "@/lib/organization.query";

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

  // Validate email format
  const isValidEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  const handleGenerateLink = useCallback(async () => {
    const data = await createMutation.mutateAsync({ email, role });
    const initialName = email
      .split("@")[0]
      .split(".")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    if (data) {
      const link = `${window.location.origin}/auth/sign-up-with-invitation?invitationId=${data.id}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(initialName)}`;
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
    <DialogForm className="flex min-h-0 flex-1 flex-col" onSubmit={() => {}}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 space-y-4">
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
                data-testid={E2eTestId.InviteEmailInput}
              />
              {email && !isValidEmail ? (
                <p className="text-xs text-destructive">
                  Please enter a valid email address
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The email of the person you want to invite
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <RoleSelect
                id="role"
                value={role}
                onValueChange={(value) => setRole(value as AnyRoleName)}
                disabled={createMutation.isPending}
                placeholder="Select a role"
                data-testid={E2eTestId.InviteRoleSelect}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                The role this person will have in your organization
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <Label>Invitation Link</Label>
            <div className="flex items-center gap-2">
              <Input
                value={invitationLink}
                readOnly
                className="flex-1"
                data-testid={E2eTestId.InvitationLinkInput}
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={handleCopyLink}
                data-testid={E2eTestId.InvitationLinkCopyButton}
              >
                {isCopied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Share this link with <span className="font-medium">{email}</span>{" "}
              to invite them as a <span className="font-medium">{role}</span>
            </p>
          </div>
        )}
      </div>
      <DialogStickyFooter>
        {invitationLink ? (
          <>
            <Button onClick={handleReset} type="button" variant="outline">
              Create Another
            </Button>
            <Button type="button" onClick={handleCopyLink}>
              {isCopied ? (
                <Check className="mr-2 h-4 w-4 text-green-600" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              Copy Link
            </Button>
          </>
        ) : (
          <>
            <div />
            <PermissionButton
              permissions={{ invitation: ["create"] }}
              onClick={handleGenerateLink}
              disabled={createMutation.isPending || !isValidEmail}
              data-testid={E2eTestId.GenerateInvitationButton}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Generate Invitation Link
            </PermissionButton>
          </>
        )}
      </DialogStickyFooter>
    </DialogForm>
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
            <div className="space-y-4 py-4">
              <p
                className="text-sm text-destructive"
                data-testid={E2eTestId.InvitationErrorMessage}
              >
                {error instanceof Error
                  ? error.message
                  : "Failed to create invitation"}
              </p>
              <Button onClick={resetErrorBoundary} variant="outline">
                Try Again
              </Button>
            </div>
          )}
        >
          <InviteByLinkCardContent
            organizationId={organizationId}
            onInvitationCreated={onInvitationCreated}
          />
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}
