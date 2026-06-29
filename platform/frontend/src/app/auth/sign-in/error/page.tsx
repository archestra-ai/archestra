import { redirect } from "next/navigation";

/**
 * SSO Error Redirect Handler
 *
 * This route handles SSO authentication errors from Better Auth's SSO plugin.
 * When an internal SSO error occurs (e.g., JWKS endpoint not found, token verification failed),
 * Better Auth redirects to `{errorCallbackURL}/error?error=...&error_description=...`.
 *
 * This page captures those error parameters and redirects to /auth/sign-in where the
 * AuthViewWithErrorHandling component displays the appropriate error message.
 */
export default async function SsoErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}) {
  const params = await searchParams;
  const { error, error_description } = params;

  // Build the redirect URL with error params
  const redirectUrl = new URL("/auth/sign-in", "http://localhost");

  if (error) {
    redirectUrl.searchParams.set("error", error);
  }
  if (error_description) {
    redirectUrl.searchParams.set("error_description", error_description);
  }

  // Redirect to the sign-in page with error params preserved
  // The pathname + search gives us the relative URL
  redirect(redirectUrl.pathname + redirectUrl.search);
}
