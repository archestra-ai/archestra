"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { AlertCircle, ExternalLink, KeyRound, XCircle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import config from "@/lib/config";

const { SsoProviderSelector } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE component with SSO / external teams
    await import("@/components/sso-provider-selector.ee")
  : {
      SsoProviderSelector: () => null,
    };

const { usePublicSsoProviders } = config.enterpriseLicenseActivated
  ? // biome-ignore lint/style/noRestrictedImports: Conditional EE query import
    await import("@/lib/sso-provider.query.ee")
  : {
      usePublicSsoProviders: () => ({
        data: [],
        isLoading: false,
        isError: false,
        error: null,
      }),
    };

/**
 * Map of SSO error codes to user-friendly messages.
 * These errors come from Better Auth's SSO plugin as query parameters.
 */
const SSO_ERROR_MESSAGES: Record<string, { title: string; message: string }> = {
  account_not_linked: {
    title: "Account Not Linked",
    message:
      "Your SSO account could not be linked to an existing account. Please contact your administrator to verify the SSO provider configuration.",
  },
  "account not linked": {
    title: "Account Not Linked",
    message:
      "Your SSO account could not be linked to an existing account. Please contact your administrator to verify the SSO provider configuration.",
  },
  invalid_provider: {
    title: "SSO Provider Error",
    message:
      "There was a problem with the SSO provider configuration. Please contact your administrator to verify the SSO settings.",
  },
  invalid_state: {
    title: "Invalid Session State",
    message:
      "Your authentication session has expired or is invalid. Please try signing in again.",
  },
  access_denied: {
    title: "Access Denied",
    message:
      "Access was denied by the identity provider. You may not have permission to access this application.",
  },
  invalid_request: {
    title: "Invalid Request",
    message:
      "The authentication request was invalid. Please try signing in again.",
  },
  unauthorized_client: {
    title: "Unauthorized Client",
    message:
      "This application is not authorized to use the identity provider. Please contact your administrator.",
  },
  unsupported_response_type: {
    title: "Configuration Error",
    message:
      "The SSO provider configuration is incorrect. Please contact your administrator.",
  },
  invalid_scope: {
    title: "Invalid Scope",
    message:
      "The requested permissions are not valid. Please contact your administrator.",
  },
  server_error: {
    title: "Server Error",
    message:
      "The identity provider encountered an error. Please try again later.",
  },
  temporarily_unavailable: {
    title: "Service Unavailable",
    message:
      "The identity provider is temporarily unavailable. Please try again later.",
  },
  login_required: {
    title: "Login Required",
    message: "You need to authenticate with the identity provider first.",
  },
  consent_required: {
    title: "Consent Required",
    message:
      "Additional consent is required to complete the sign-in. Please try again and grant the required permissions.",
  },
  interaction_required: {
    title: "Interaction Required",
    message:
      "Additional interaction with the identity provider is required. Please try again.",
  },
};

interface AuthViewWithErrorHandlingProps {
  path: string;
  callbackURL?: string;
}

export function AuthViewWithErrorHandling({
  path,
  callbackURL,
}: AuthViewWithErrorHandlingProps) {
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState(false);
  const [ssoError, setSsoError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const { data: ssoProviders = [], isLoading: isLoadingSsoProviders } =
    usePublicSsoProviders();

  const isBasicAuthDisabled = config.disableBasicAuth;
  const hasSsoProviders = ssoProviders.length > 0;

  // Check for SSO error in query params
  useEffect(() => {
    const errorParam = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    if (errorParam) {
      const decodedError = decodeURIComponent(errorParam).toLowerCase();
      const errorInfo =
        SSO_ERROR_MESSAGES[decodedError] ||
        SSO_ERROR_MESSAGES[errorParam.toLowerCase()];

      if (errorInfo) {
        setSsoError(errorInfo);
      } else {
        // Generic fallback for unknown errors
        // Include error_description if available for more context
        const decodedDescription = errorDescription
          ? decodeURIComponent(errorDescription).replace(/_/g, " ")
          : null;

        setSsoError({
          title: "Sign-In Failed",
          message: decodedDescription
            ? `An error occurred during sign-in: ${decodedDescription}. Please try again or contact your administrator.`
            : `An error occurred during sign-in: ${decodeURIComponent(errorParam)}. Please try again or contact your administrator.`,
        });
      }
    }
  }, [searchParams]);

  useEffect(() => {
    // Intercept fetch to detect 500 errors from auth endpoints
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      try {
        const response = await originalFetch(...args);
        const url =
          typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url;

        // Check if this is a sign-in/sign-up request and if it's a server error
        // Only show error for actual auth attempts, not status checks
        if (
          (url?.includes("/api/auth/sign-in") ||
            url?.includes("/api/auth/sign-up") ||
            url?.includes("/api/auth/forgot-password") ||
            url?.includes("/api/auth/reset-password")) &&
          response.status >= 500
        ) {
          console.error(
            `Server error (${response.status}) from auth endpoint:`,
            url,
          );
          setServerError(true);
        }

        return response;
      } catch (error) {
        // Network errors or other fetch failures for auth endpoints
        const url =
          typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url;
        if (
          url?.includes("/api/auth/sign-in") ||
          url?.includes("/api/auth/sign-up") ||
          url?.includes("/api/auth/forgot-password") ||
          url?.includes("/api/auth/reset-password")
        ) {
          console.error("Network error from auth endpoint:", url, error);
          setServerError(true);
        }
        throw error;
      }
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  const isSignInPage = path === "sign-in";

  // These paths should always render AuthView regardless of basic auth setting
  // (sign-out, callback, error, etc. are handled by better-auth-ui)
  const alwaysShowAuthView = !isSignInPage && path !== "sign-up";

  // When basic auth is disabled and SSO providers are still loading, wait (only for sign-in)
  if (isBasicAuthDisabled && isLoadingSsoProviders && isSignInPage) {
    return null;
  }

  // When basic auth is disabled and no SSO providers are configured, show a message
  if (isBasicAuthDisabled && !hasSsoProviders && isSignInPage) {
    return (
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <KeyRound className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle>Authentication Required</CardTitle>
          <CardDescription>
            Basic authentication has been disabled for this instance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground text-center">
            Please contact your administrator to configure an SSO provider for
            authentication.
          </p>
        </CardContent>
      </Card>
    );
  }

  const ssoErrorAlert = ssoError && isSignInPage && (
    <Alert className="mb-4 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
      <XCircle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-900 dark:text-amber-100">
        {ssoError.title}
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
        <p className="text-sm">{ssoError.message}</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSsoError(null);
            // Clear the error params from URL without page reload
            const url = new URL(window.location.href);
            url.searchParams.delete("error");
            url.searchParams.delete("error_description");
            window.history.replaceState({}, "", url.toString());
          }}
          className="mt-2 hover:bg-amber-100 dark:hover:bg-amber-900"
        >
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );

  // When basic auth is disabled but SSO providers exist, show SSO in a card
  if (
    isBasicAuthDisabled &&
    hasSsoProviders &&
    isSignInPage &&
    config.enterpriseLicenseActivated
  ) {
    return (
      <div className="w-full max-w-md space-y-4">
        {ssoErrorAlert}
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>
              Sign in to your account using single sign-on
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SsoProviderSelector showDivider={false} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      {ssoErrorAlert}
      {serverError && isSignInPage && (
        <Alert className="mb-4 border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 max-w-sm">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          <AlertTitle className="text-red-900 dark:text-red-100">
            Server Error Occurred
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <div className="space-y-2">
              <p className="text-sm font-medium text-red-700 dark:text-red-300">
                Please help us fix this issue:
              </p>
              <ol className="list-decimal list-inside space-y-1 text-sm text-red-700 dark:text-red-300">
                <li>
                  Collect the backend logs from your terminal or Docker
                  container
                </li>
                <li>
                  File a bug report on our GitHub repository with the error
                  details
                </li>
              </ol>
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                className="border-red-300 hover:bg-red-100 dark:border-red-700 dark:hover:bg-red-900"
                asChild
              >
                <a
                  href="https://github.com/archestra-ai/archestra/issues/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center"
                >
                  <ExternalLink className="mr-2 h-3 w-3" />
                  Report on GitHub
                </a>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setServerError(false)}
                className="hover:bg-red-100 dark:hover:bg-red-900"
              >
                Dismiss
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-4">
        {(!isBasicAuthDisabled || alwaysShowAuthView) && (
          <AuthView
            path={path}
            callbackURL={callbackURL}
            classNames={{
              base: "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm w-full max-w-full",
              footer: "hidden",
              form: { forgotPasswordLink: "hidden" },
            }}
          />
        )}
        {isSignInPage && config.enterpriseLicenseActivated && (
          <SsoProviderSelector showDivider={!isBasicAuthDisabled} />
        )}
      </div>
    </>
  );
}
