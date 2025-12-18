"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/clients/auth/auth-client";

interface VerifyEmailProps {
  className?: string;
}

export function VerifyEmail({ className }: VerifyEmailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);

  const token = searchParams.get("token");

  useEffect(() => {
    const verifyEmail = async () => {
      if (!token) {
        setStatus("error");
        setError("Invalid or missing verification token.");
        return;
      }

      try {
        const result = await authClient.verifyEmail({
          query: { token },
        });

        if (result.error) {
          setStatus("error");
          setError(
            result.error.message ||
              "Failed to verify email. The link may have expired.",
          );
          return;
        }

        setStatus("success");

        // Redirect to home page after 3 seconds
        setTimeout(() => {
          router.push("/");
        }, 3000);
      } catch (err) {
        setStatus("error");
        setError("An unexpected error occurred. Please try again.");
        console.error("Email verification error:", err);
      }
    };

    verifyEmail();
  }, [token, router]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {status === "loading" && <Loader2 className="h-6 w-6 animate-spin" />}
          {status === "success" && (
            <CheckCircle2 className="h-6 w-6 text-green-600" />
          )}
          {status === "error" && <XCircle className="h-6 w-6 text-destructive" />}
          {status === "loading" && "Verifying Email"}
          {status === "success" && "Email Verified"}
          {status === "error" && "Verification Failed"}
        </CardTitle>
        <CardDescription>
          {status === "loading" && "Please wait while we verify your email address..."}
          {status === "success" && "Your email has been successfully verified"}
          {status === "error" && "We couldn't verify your email address"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {status === "loading" && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
          </div>
        )}

        {status === "success" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Thank you for verifying your email address. You'll be redirected
              to the home page shortly.
            </p>
            <Button onClick={() => router.push("/")} className="w-full">
              Go to Home
            </Button>
          </div>
        )}

        {status === "error" && (
          <div className="space-y-4">
            {error && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Button
                onClick={() => router.push("/auth/sign-in")}
                className="w-full"
              >
                Go to Sign In
              </Button>
              <Button
                onClick={() => router.push("/")}
                variant="outline"
                className="w-full"
              >
                Go to Home
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
