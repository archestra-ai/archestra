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
          setInvitation(data);
        }
      } catch (_err) {
        setError("An unexpected error occurred");
      } finally {
        setIsLoading(false);
      }
    };

    fetchInvitation();
  }, [invitationId]);

  const handleAccept = async () => {
    if (!session) {
      const signUpUrl = `/sign-up?email=${encodeURIComponent(invitation?.email || "")}&redirect=/accept-invitation/${invitationId}`;
      toast.info("Create your account", {
        description:
          "Please create an account or sign in to accept this invitation",
      });
      router.push(signUpUrl);
      return;
    }

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
    if (!session) {
      const signInUrl = `/sign-in?email=${encodeURIComponent(invitation?.email || "")}&redirect=/accept-invitation/${invitationId}`;
      toast.info("Sign in required", {
        description: "Please sign in to reject this invitation",
      });
      router.push(signInUrl);
      return;
    }

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
                {invitation.organization?.name || "Unknown"}
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
                {invitation.inviter?.user?.name ||
                  invitation.inviter?.user?.email ||
                  "Unknown"}
              </span>
            </div>
          </div>

          {!session ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                To join this organization, you need to create an account or sign
                in.
              </p>
              <div className="flex flex-col gap-2">
                <Button
                  onClick={() =>
                    router.push(
                      `/sign-up?email=${encodeURIComponent(invitation?.email || "")}&redirect=/accept-invitation/${invitationId}`,
                    )
                  }
                  className="w-full"
                >
                  Create Account & Accept
                </Button>
                <Button
                  onClick={() =>
                    router.push(
                      `/sign-in?email=${encodeURIComponent(invitation?.email || "")}&redirect=/accept-invitation/${invitationId}`,
                    )
                  }
                  variant="outline"
                  className="w-full"
                >
                  Already have an account? Sign In
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                onClick={handleAccept}
                disabled={isAccepting}
                className="flex-1"
              >
                {isAccepting && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
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
          )}
        </CardContent>
      </Card>
    </main>
  );
}
