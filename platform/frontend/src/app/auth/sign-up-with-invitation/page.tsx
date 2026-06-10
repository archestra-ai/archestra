"use client";

import { AUTO_PROVISIONED_INVITATION_STATUS } from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AppLogo } from "@/components/app-logo";
import { CommunityLinks } from "@/components/community-links";
import { LoadingSpinner } from "@/components/loading";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { useInvitationCheck } from "@/lib/auth/invitation.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";

type AuthClientError = {
  message?: string;
  statusText?: string;
};

type InvitationSignUpPayload = Parameters<typeof authClient.signUp.email>[0] & {
  invitationId: string;
};

function SignUpWithInvitationContent() {
  const appName = useAppName();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const invitationId = searchParams.get("invitationId");
  const emailParam = searchParams.get("email") ?? "";
  const nameParam = searchParams.get("name") ?? "";
  const { data: invitationData, isLoading: isCheckingInvitation } =
    useInvitationCheck(invitationId);
  const [name, setName] = useState(nameParam);
  const [email, setEmail] = useState(emailParam);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setName(nameParam);
  }, [nameParam]);

  useEffect(() => {
    setEmail(emailParam);
  }, [emailParam]);

  // Redirect existing users to sign-in (unless auto-provisioned — they need to sign up)
  useEffect(() => {
    if (
      invitationId &&
      invitationData?.userExists &&
      !invitationData.invitation?.status?.startsWith(
        AUTO_PROVISIONED_INVITATION_STATUS,
      )
    ) {
      router.push(`/auth/sign-in?invitationId=${invitationId}`);
    }
  }, [invitationId, invitationData, router]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!invitationId) {
      toast.error("Invitation link is missing an invitation ID");
      return;
    }

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName || !trimmedEmail || !password) {
      toast.error("Name, email, and password are required");
      return;
    }

    setIsSubmitting(true);
    const payload: InvitationSignUpPayload = {
      name: trimmedName,
      email: trimmedEmail,
      password,
      callbackURL: "/chat",
      invitationId,
    };

    try {
      const { error } = await authClient.signUp.email(payload);

      if (error) {
        toast.error(getAuthErrorMessage(error, "Failed to create account"));
        return;
      }

      await queryClient.invalidateQueries({ queryKey: authQueryKeys.all });
      router.replace("/chat");
    } catch {
      toast.error("Failed to create account");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isCheckingInvitation && invitationId) {
    return (
      <main className="h-full flex items-center justify-center">
        <LoadingSpinner />
      </main>
    );
  }

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <main className="h-full flex items-center justify-center p-4">
          <div className="w-full max-w-sm space-y-4">
            <AppLogo />
            {invitationId && (
              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center space-y-2">
                <p className="text-sm text-blue-900 dark:text-blue-100 font-medium">
                  You've been invited to join the {appName} workspace
                </p>
                {email && (
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    Email: {email}
                  </p>
                )}
              </div>
            )}
            <Card>
              <CardHeader>
                <CardTitle>Sign Up</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Enter your information to create an account
                </p>
              </CardHeader>
              <CardContent>
                <form className="space-y-4" onSubmit={handleSubmit}>
                  <div className="space-y-2">
                    <Label htmlFor="invitation-name">Name</Label>
                    <Input
                      id="invitation-name"
                      name="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invitation-email">Email</Label>
                    <Input
                      id="invitation-email"
                      name="email"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="invitation-password">Password</Label>
                    <div className="relative">
                      <Input
                        id="invitation-password"
                        name="password"
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        className="pr-10"
                        required
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
                        onClick={() => setShowPassword((value) => !value)}
                      >
                        {showPassword ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                        <span className="sr-only">
                          {showPassword ? "Hide password" : "Show password"}
                        </span>
                      </Button>
                    </div>
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isSubmitting || !invitationId}
                  >
                    {isSubmitting ? "Creating account..." : "Create an account"}
                  </Button>
                </form>
              </CardContent>
            </Card>
            <CommunityLinks />
          </div>
        </main>
      </Suspense>
    </ErrorBoundary>
  );
}

export default function SignUpWithInvitationPage() {
  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner />}>
        <SignUpWithInvitationContent />
      </Suspense>
    </ErrorBoundary>
  );
}

function getAuthErrorMessage(error: AuthClientError, fallback: string) {
  return error.message ?? error.statusText ?? fallback;
}
