"use client";

import { OAUTH_SCOPE_DESCRIPTIONS, OAUTH_SCOPES } from "@shared";
import { Shield } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useOAuthClientInfo, useSubmitOAuthConsent } from "@/lib/oauth.query";

export function ConsentForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const clientId = searchParams.get("client_id");
  const queryClientName = searchParams.get("client_name");

  // Fetch client name from OAuth client registration if not in query params
  const { data: clientInfo } = useOAuthClientInfo(
    queryClientName ? null : clientId,
  );
  const clientName =
    queryClientName || clientInfo?.client_name || "Application";

  const scope = searchParams.get("scope") || OAUTH_SCOPES[0];
  const scopes = scope.split(" ").filter(Boolean);

  // Reconstruct the original OAuth query from search params
  const oauthQuery = searchParams.toString();

  const consentMutation = useSubmitOAuthConsent();

  const handleConsent = async (accept: boolean) => {
    setError(null);

    try {
      const data = await consentMutation.mutateAsync({
        accept,
        scope,
        oauth_query: oauthQuery,
      });

      if (data?.redirectTo) {
        window.location.href = data.redirectTo;
        return;
      }

      // If rejected, redirect to home
      if (!accept) {
        router.push("/");
        return;
      }

      setError("Unexpected response from server");
    } catch (err) {
      console.error("[OAuth Consent] Failed to process consent:", err);
      setError("Failed to process consent. Please try again.");
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Shield className="h-6 w-6 text-primary" />
        </div>
        <CardTitle>Authorization Request</CardTitle>
        <CardDescription>
          <span className="font-semibold text-foreground">{clientName}</span> is
          requesting access to your account
        </CardDescription>
      </CardHeader>

      <CardContent>
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            This application is requesting the following permissions:
          </p>
          <div className="space-y-2">
            {scopes.map((s) => (
              <div
                key={s}
                className="flex items-center gap-2 rounded-md border p-2"
              >
                <Badge variant="secondary" className="shrink-0">
                  {s}
                </Badge>
                <span className="text-sm">
                  {OAUTH_SCOPE_DESCRIPTIONS[
                    s as keyof typeof OAUTH_SCOPE_DESCRIPTIONS
                  ] || s}
                </span>
              </div>
            ))}
          </div>
        </div>
        {error && <p className="mt-3 text-destructive text-sm">{error}</p>}
      </CardContent>

      <CardFooter className="flex gap-3">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => handleConsent(false)}
          disabled={consentMutation.isPending}
        >
          Deny
        </Button>
        <Button
          className="flex-1"
          onClick={() => handleConsent(true)}
          disabled={consentMutation.isPending}
        >
          {consentMutation.isPending ? "Processing..." : "Allow"}
        </Button>
      </CardFooter>
    </Card>
  );
}
