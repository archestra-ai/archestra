"use client";

import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useAcceptInvitation,
  useInvitation,
  useRejectInvitation,
} from "@/lib/organization.query";

function InvitationContent() {
  const params = useParams();
  const router = useRouter();
  const invitationId = params.id as string;

  const { data: session } = authClient.useSession();
  const { data: invitation, error: invitationError } =
    useInvitation(invitationId);
  const acceptMutation = useAcceptInvitation();
  const rejectMutation = useRejectInvitation();

  // If user is not authenticated, redirect immediately to sign-up
  useEffect(() => {
    if (!session && invitationId) {
      const redirectUrl = `/auth/sign-up-with-invitation?invitationId=${invitationId}`;
      router.push(redirectUrl);
    }
  }, [session, invitationId, router]);

  // Check if invitation is already accepted
  useEffect(() => {
    if (invitation?.status === "accepted") {
      router.push("/");
    }
  }, [invitation, router]);

  const handleAccept = async () => {
    await acceptMutation.mutateAsync(invitationId);
  };

  const handleReject = async () => {
    await rejectMutation.mutateAsync(invitationId);
  };

  const isProcessing = acceptMutation.isPending || rejectMutation.isPending;
  if (invitationError) {
    return (
      <main className="container p-4 md:p-6 flex items-center justify-center min-h-[60vh]">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Invalid Invitation
            </CardTitle>
            <CardDescription>
              {invitationError?.message ||
                "This invitation is invalid or has expired"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => router.push("/")}
              variant="outline"
              className="w-full"
            >
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }
  return (
    <main className="container p-4 md:p-6 flex items-center justify-center min-h-[60vh]">
      {invitation ? (
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Organization Invitation
            </CardTitle>
            <CardDescription>
              You have been invited to join an organization
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-sm font-medium">Organization:</span>
                <span className="text-sm text-muted-foreground">
                  {invitation?.organizationName || "Unknown"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Role:</span>
                <span className="text-sm text-muted-foreground capitalize">
                  {invitation?.role}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm font-medium">Invited by:</span>
                <span className="text-sm text-muted-foreground">
                  {invitation?.inviterEmail || "Unknown"}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleAccept}
                disabled={isProcessing}
                className="flex-1"
              >
                {acceptMutation.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Accept
              </Button>
              <Button
                onClick={handleReject}
                disabled={isProcessing}
                variant="outline"
                className="flex-1"
              >
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <LoadingSpinner />
      )}
    </main>
  );
}

export default function AcceptInvitationPage() {
  return (
    <div className="container mx-auto">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <InvitationContent />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
