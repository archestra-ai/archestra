"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { AlertCircle, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface AuthViewWithErrorHandlingProps {
  path: string;
  classNames?: {
    footer?: string;
    form?: {
      forgotPasswordLink?: string;
    };
  };
}

export function AuthViewWithErrorHandling({
  path,
  classNames,
}: AuthViewWithErrorHandlingProps) {
  const [serverError, setServerError] = useState(false);

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

  return (
    <>
      {serverError && path === "sign-in" && (
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
      <AuthView path={path} classNames={classNames} />
    </>
  );
}
