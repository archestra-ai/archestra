"use client";

import { OAUTH_SCOPE_DESCRIPTIONS, OAUTH_SCOPES } from "@archestra/shared";
import { CircleAlert, Clock, Shield } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
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
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import {
  useOAuthClientInfo,
  useSubmitOAuthConsent,
} from "@/lib/auth/oauth.query";
import { postConnected } from "@/lib/connect-signal";

export function ConsentForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [externalRedirectTarget, setExternalRedirectTarget] = useState<
    string | null
  >(null);

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

  // The authorization server signs this query with a short expiry (`exp`, in
  // seconds). Past it, consent can never succeed, so the page says so instead
  // of offering buttons that fail on every click.
  const expiresAtMs = parseExpiresAtMs(searchParams.get("exp"));
  const [isExpired, setIsExpired] = useState(() => hasExpired(expiresAtMs));
  useEffect(() => {
    if (expiresAtMs === null || hasExpired(expiresAtMs)) return;
    const timeout = setTimeout(
      () => setIsExpired(true),
      // setTimeout fires at once for delays past 2^31-1 ms.
      Math.min(expiresAtMs - Date.now(), 2 ** 31 - 1),
    );
    return () => clearTimeout(timeout);
  }, [expiresAtMs]);

  const consentMutation = useSubmitOAuthConsent();

  const handleConsent = async (accept: boolean) => {
    setError(null);

    // Background tabs throttle timers, so check again at click time.
    if (hasExpired(expiresAtMs)) {
      setIsExpired(true);
      return;
    }

    try {
      const data = await consentMutation.mutateAsync({
        accept,
        scope,
        oauth_query: oauthQuery,
      });

      if (data?.redirectTo) {
        // Tell the Connect page in another tab to show what's next.
        if (accept) postConnected();
        if (isExternalProtocolRedirect(data.redirectTo)) {
          setExternalRedirectTarget(data.redirectTo);
          window.location.assign(data.redirectTo);
          return;
        }

        window.location.replace(data.redirectTo);
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
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to process consent. Please try again.",
      );
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
          {externalRedirectTarget ? (
            <>
              Returning you to{" "}
              <span className="font-semibold text-foreground">
                {clientName}
              </span>
            </>
          ) : isExpired ? (
            <>
              <span className="font-semibold text-foreground">
                {clientName}
              </span>{" "}
              was requesting access to your account
            </>
          ) : (
            <>
              <span className="font-semibold text-foreground">
                {clientName}
              </span>{" "}
              is requesting access to your account
            </>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent>
        {externalRedirectTarget ? (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              If the app did not open automatically,{" "}
              <a
                href={externalRedirectTarget}
                className="font-medium text-primary underline underline-offset-2"
              >
                switch back to it manually
              </a>
              . You can close this tab after the authorization flow completes.
            </p>
          </div>
        ) : isExpired ? (
          <InlineNotice>
            <Clock />
            <InlineNoticeBody>
              <span className="font-medium">Request expired</span>
              <InlineNoticeText>
                For your security, authorization requests expire after a few
                minutes. Go back to{" "}
                {queryClientName ||
                  clientInfo?.client_name ||
                  "the application"}{" "}
                and connect again to start a new request.
              </InlineNoticeText>
            </InlineNoticeBody>
          </InlineNotice>
        ) : (
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
        )}
        {error && !isExpired && (
          <InlineNotice variant="error" className="mt-3">
            <CircleAlert />
            <InlineNoticeText>{error}</InlineNoticeText>
          </InlineNotice>
        )}
      </CardContent>

      {!externalRedirectTarget && !isExpired && (
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
      )}
    </Card>
  );
}

function parseExpiresAtMs(exp: string | null): number | null {
  const seconds = Number(exp);
  return exp && Number.isFinite(seconds) ? seconds * 1000 : null;
}

function hasExpired(expiresAtMs: number | null): boolean {
  return expiresAtMs !== null && Date.now() >= expiresAtMs;
}

function isExternalProtocolRedirect(redirectTo: string): boolean {
  return (
    !redirectTo.startsWith("/") &&
    !redirectTo.startsWith("http://") &&
    !redirectTo.startsWith("https://")
  );
}
