"use client";

import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

export default function AcceptInvitationPage() {
  const params = useParams();
  const router = useRouter();
  const invitationId = params.id as string;

  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [invitation, setInvitation] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: session } = authClient.useSession();

  useEffect(() => {
    const fetchInvitation = async () => {
      if (!invitationId) return;

      // If user is not authenticated, redirect immediately to sign-up
      if (!session) {
        const signUpUrl = `/auth/sign-up-with-invitation?invitationId=${invitationId}`;
        router.push(signUpUrl);
        return;
      }

      setIsLoading(true);
      try {
        const { data, error } = await authClient.organization.getInvitation({
          query: {
            id: invitationId,
          },
        });

        if (error) {
          setError(error.message || "Failed to load invitation");
        } else if (data) {
          // Check if invitation is already accepted
          if (data.status === "accepted") {
            toast.info("Already accepted", {
              description: "This invitation has already been accepted",
            });
            router.push("/");
            return;
          }

          setInvitation(data);
        }
      } catch (_err) {
        setError("An unexpected error occurred");
      } finally {
        setIsLoading(false);
      }
    };

    fetchInvitation();
  }, [invitationId, session, router]);

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      });

      if (error) {
        toast.error("Error", {
          description: error.message || "Failed to accept invitation",
        });
      } else {
        toast.success("Invitation accepted", {
          description: "You have successfully joined the organization",
        });
        router.push("/");
      }
    } catch (_err) {
      toast.error("Error", {
        description: "An unexpected error occurred",
      });
    } finally {
      setIsAccepting(false);
    }
  };

  const handleReject = async () => {
    setIsAccepting(true);
    try {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      });

      if (error) {
        toast.error("Error", {
          description: error.message || "Failed to reject invitation",
        });
      } else {
        toast.success("Invitation rejected", {
          description: "You have declined the invitation",
        });
        router.push("/");
      }
    } catch (_err) {
      toast.error("Error", {
        description: "An unexpected error occurred",
      });
    } finally {
      setIsAccepting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="container p-4 md:p-6 flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-muted-foreground">Loading invitation...</p>
        </div>
      </main>
    );
  }

  if (error || !invitation) {
    return (
      <main className="container p-4 md:p-6 flex items-center justify-center min-h-[60vh]">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Invalid Invitation
            </CardTitle>
            <CardDescription>
              {error || "This invitation is invalid or has expired"}
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
                {invitation.organizationName || "Unknown"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm font-medium">Role:</span>
              <span className="text-sm text-muted-foreground capitalize">
                {invitation.role}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm font-medium">Invited by:</span>
              <span className="text-sm text-muted-foreground">
                {invitation.inviterEmail || "Unknown"}
              </span>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={handleAccept}
              disabled={isAccepting}
              className="flex-1"
            >
              {isAccepting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Accept
            </Button>
            <Button
              onClick={handleReject}
              disabled={isAccepting}
              variant="outline"
              className="flex-1"
            >
              Reject
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
