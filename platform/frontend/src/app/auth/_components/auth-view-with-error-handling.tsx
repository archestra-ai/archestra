"use client";

import { AuthView } from "@daveyplate/better-auth-ui";
import { zodResolver } from "@hookform/resolvers/zod";
import { E2eTestId, GITHUB_REPO_NEW_ISSUE_URL } from "@shared";
import {
  AlertCircle,
  ExternalLink,
  KeyRound,
  Loader2,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useChangeAccountPasswordMutation,
  useSignInWithEmailMutation,
} from "@/lib/auth/account.query";
import { clearDefaultPasswordChangePending } from "@/lib/auth/default-password-change";
import {
  clearSsoSignInAttempt,
  hasSsoSignInAttempt,
} from "@/lib/auth/sso-sign-in-attempt";
import config from "@/lib/config/config";
import { usePublicConfig } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { SignOutWithIdpLogout } from "./sign-out-with-idp-logout";

const { IdentityProviderSelector } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: conditional EE component with IdP selector
    await import("@/components/identity-provider-selector.ee")
  : {
      IdentityProviderSelector: () => null,
    };

const { usePublicIdentityProviders } = config.enterpriseFeatures.core
  ? // biome-ignore lint/style/noRestrictedImports: Conditional EE query import
    await import("@/lib/auth/identity-provider.query.ee")
  : {
      usePublicIdentityProviders: () => ({
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

const GENERIC_SSO_SIGN_IN_FAILED = {
  title: "Sign-In Failed",
  message:
    "Single sign-on could not be completed. Please try again or contact your administrator.",
};

const SignInFormSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

const DefaultPasswordChangeFormSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SignInFormValues = z.infer<typeof SignInFormSchema>;
type DefaultPasswordChangeFormValues = z.infer<
  typeof DefaultPasswordChangeFormSchema
>;

interface AuthViewWithErrorHandlingProps {
  path: string;
  callbackURL?: string;
}

export function AuthViewWithErrorHandling({
  path,
  callbackURL,
}: AuthViewWithErrorHandlingProps) {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const [serverError, setServerError] = useState(false);
  const [originError, setOriginError] = useState<string | null>(null);
  const [ssoError, setSsoError] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const { data: publicConfig, isLoading: isLoadingPublicConfig } =
    usePublicConfig();
  const { data: identityProvidersData, isLoading: isLoadingIdentityProviders } =
    usePublicIdentityProviders();

  const isBasicAuthDisabled = publicConfig?.disableBasicAuth ?? false;
  // Extract providers array - data can be null or an array of providers
  const identityProviders = Array.isArray(identityProvidersData)
    ? identityProvidersData
    : [];
  const hasIdentityProviders = identityProviders.length > 0;

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
      return;
    }

    if (path === "sign-in" && hasSsoSignInAttempt()) {
      setSsoError(GENERIC_SSO_SIGN_IN_FAILED);
      clearSsoSignInAttempt();
    }
  }, [path, searchParams]);

  useEffect(() => {
    // Intercept fetch to detect 500 errors from auth endpoints
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      try {
        const response = await originalFetch(...args);
        const url =
          typeof args[0] === "string" ? args[0] : (args[0] as Request)?.url;

        const isAuthEndpoint =
          url?.includes("/api/auth/sign-in") ||
          url?.includes("/api/auth/sign-up") ||
          url?.includes("/api/auth/forgot-password") ||
          url?.includes("/api/auth/reset-password");

        // Check for 403 "Invalid origin" errors
        if (isAuthEndpoint && response.status === 403) {
          try {
            const cloned = response.clone();
            const body = await cloned.json();
            if (
              typeof body?.message === "string" &&
              (body.message.includes("Invalid origin") ||
                body.message.includes("not trusted"))
            ) {
              setOriginError(window.location.origin);
            }
          } catch {
            // Ignore parse errors
          }
        }

        // Check if this is a sign-in/sign-up request and if it's a server error
        // Only show error for actual auth attempts, not status checks
        if (isAuthEndpoint && response.status >= 500) {
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

  if (path === "sign-out") {
    return <SignOutWithIdpLogout />;
  }

  const isSignInPage = path === "sign-in";

  // These paths should always render AuthView regardless of basic auth setting
  // (callback, error, etc. are handled by better-auth-ui)
  const alwaysShowAuthView = !isSignInPage && path !== "sign-up";

  if (isLoadingPublicConfig && isSignInPage) {
    return null;
  }

  // When basic auth is disabled and SSO providers are still loading, wait (only for sign-in)
  if (isBasicAuthDisabled && isLoadingIdentityProviders && isSignInPage) {
    return null;
  }

  // When basic auth is disabled and no SSO providers are configured, show a message
  if (isBasicAuthDisabled && !hasIdentityProviders && isSignInPage) {
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
            clearSsoSignInAttempt();
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
    hasIdentityProviders &&
    isSignInPage &&
    config.enterpriseFeatures.core
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
            <IdentityProviderSelector
              showDivider={false}
              callbackURL={callbackURL}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const originErrorAlert = originError && isSignInPage && (
    <Alert className="mb-4 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950 max-w-sm">
      <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-900 dark:text-amber-100">
        Origin Not Allowed
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
        <p className="text-sm mb-2">
          You are accessing {appName} from <code>{originError}</code>, which is
          not in the list of trusted origins.
        </p>
        <p className="text-sm mb-2">
          To fix this, set the environment variable:
        </p>
        <pre className="text-xs bg-amber-100 dark:bg-amber-900 p-2 rounded mb-2 overflow-x-auto">
          ARCHESTRA_FRONTEND_URL={originError}
        </pre>
        <p className="text-sm">
          For multiple origins, use{" "}
          <code>ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS</code>.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setOriginError(null)}
          className="mt-2 hover:bg-amber-100 dark:hover:bg-amber-900"
        >
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );

  return (
    <>
      {ssoErrorAlert}
      {originErrorAlert}
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
                  href={GITHUB_REPO_NEW_ISSUE_URL}
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
        {!isBasicAuthDisabled && isSignInPage ? (
          <SignInView callbackURL={callbackURL} />
        ) : (
          alwaysShowAuthView && (
            <AuthView
              path={path}
              callbackURL={callbackURL}
              classNames={{
                base: "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm w-full max-w-full",
                footer: "hidden",
                form: { forgotPasswordLink: "hidden" },
              }}
            />
          )
        )}
        {!isSignInPage && !alwaysShowAuthView && !isBasicAuthDisabled && (
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
        {isSignInPage && config.enterpriseFeatures.core && (
          <IdentityProviderSelector
            showDivider={!isBasicAuthDisabled}
            callbackURL={callbackURL}
          />
        )}
      </div>
    </>
  );
}

function SignInView({ callbackURL }: { callbackURL?: string }) {
  const [defaultPasswordRedirectUrl, setDefaultPasswordRedirectUrl] = useState<
    string | null
  >(null);
  const [defaultAdminCurrentPassword, setDefaultAdminCurrentPassword] =
    useState<string | null>(null);
  const signIn = useSignInWithEmailMutation();
  const changePassword = useChangeAccountPasswordMutation();
  const signInForm = useForm<SignInFormValues>({
    resolver: zodResolver(SignInFormSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });
  const defaultPasswordChangeForm = useForm<DefaultPasswordChangeFormValues>({
    resolver: zodResolver(DefaultPasswordChangeFormSchema),
    defaultValues: {
      password: "",
      confirmPassword: "",
    },
  });

  async function onSignIn(values: SignInFormValues) {
    const result = await signIn.mutateAsync({
      email: values.email,
      password: values.password,
      callbackURL,
    });

    if (!result) return;

    if (result.requiresDefaultPasswordChange) {
      setDefaultPasswordRedirectUrl(result.redirectUrl);
      setDefaultAdminCurrentPassword(values.password);
      return;
    }

    clearDefaultPasswordChangePending();
    redirectAfterSignIn(result.redirectUrl);
  }

  async function onChangeDefaultPassword(
    values: DefaultPasswordChangeFormValues,
  ) {
    if (!defaultAdminCurrentPassword) return;

    const changed = await changePassword.mutateAsync({
      currentPassword: defaultAdminCurrentPassword,
      newPassword: values.password,
      revokeOtherSessions: true,
    });

    if (changed) {
      clearDefaultPasswordChangePending();
      redirectAfterSignIn(defaultPasswordRedirectUrl ?? callbackURL ?? "/");
    }
  }

  if (defaultPasswordRedirectUrl) {
    return (
      <Card
        className="w-full"
        data-testid={E2eTestId.DefaultPasswordChangePrompt}
      >
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>
            The default administrator password is still active. Choose a new
            password to secure this account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...defaultPasswordChangeForm}>
            <form
              className="space-y-4"
              onSubmit={defaultPasswordChangeForm.handleSubmit(
                onChangeDefaultPassword,
              )}
            >
              <div className="grid gap-2">
                <Label htmlFor="default-admin-new-password">New password</Label>
                <Input
                  id="default-admin-new-password"
                  type="password"
                  autoComplete="new-password"
                  disabled={changePassword.isPending}
                  aria-invalid={
                    !!defaultPasswordChangeForm.formState.errors.password
                  }
                  {...defaultPasswordChangeForm.register("password")}
                />
                {defaultPasswordChangeForm.formState.errors.password && (
                  <p className="text-destructive text-sm">
                    {
                      defaultPasswordChangeForm.formState.errors.password
                        .message
                    }
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="default-admin-confirm-password">
                  Confirm password
                </Label>
                <Input
                  id="default-admin-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  disabled={changePassword.isPending}
                  aria-invalid={
                    !!defaultPasswordChangeForm.formState.errors.confirmPassword
                  }
                  {...defaultPasswordChangeForm.register("confirmPassword")}
                />
                {defaultPasswordChangeForm.formState.errors.confirmPassword && (
                  <p className="text-destructive text-sm">
                    {
                      defaultPasswordChangeForm.formState.errors.confirmPassword
                        .message
                    }
                  </p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={changePassword.isPending}
                  data-testid={E2eTestId.DefaultPasswordChangeSkipButton}
                  onClick={() => {
                    clearDefaultPasswordChangePending();
                    redirectAfterSignIn(defaultPasswordRedirectUrl);
                  }}
                >
                  Skip
                </Button>
                <Button type="submit" disabled={changePassword.isPending}>
                  {changePassword.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Submit
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Sign In</CardTitle>
        <CardDescription>
          Enter your email below to login to your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...signInForm}>
          <form
            className="space-y-4"
            onSubmit={signInForm.handleSubmit(onSignIn)}
          >
            <FormField
              control={signInForm.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      autoComplete="email"
                      disabled={signIn.isPending}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={signInForm.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      disabled={signIn.isPending}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={signIn.isPending}
              data-testid={E2eTestId.SignInSubmitButton}
            >
              {signIn.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Sign In
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

function redirectAfterSignIn(url: string) {
  window.location.href = url;
}
