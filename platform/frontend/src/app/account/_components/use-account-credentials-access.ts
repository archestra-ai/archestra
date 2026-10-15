import { useCredentialsPage } from "@/app/_parts/use-credentials-page";
import { useClaudeCodeAgent } from "@/app/account/_components/claude-code-subscription";
import { useHasPermissions } from "@/lib/auth/auth.query";

/**
 * What Personal Settings → Credentials can show the reader. A reader who can
 * open Settings → Credentials uses that page instead ({@link
 * useCredentialsPage}), so they get no tab here and are sent there. For
 * everyone else the credentials table needs `credential:read`, and the
 * Claude Code card a Claude Code agent. `hasTab` is false when neither
 * applies, null until known; `redirectTo` is where the tab's address sends a
 * reader who has no tab. A failed agent lookup keeps the tab, so its error
 * is shown rather than the tab vanishing.
 */
export function useAccountCredentialsAccess(): {
  canReadCredentials: boolean | undefined;
  hasTab: boolean | null;
  redirectTo: "/settings/credentials" | "/account" | null;
} {
  const credentialsPage = useCredentialsPage();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const claudeCode = useClaudeCodeAgent();
  const unknown = { canReadCredentials, hasTab: null, redirectTo: null };
  if (!credentialsPage) return unknown;
  if (credentialsPage.href === "/settings/credentials")
    return {
      canReadCredentials,
      hasTab: false,
      redirectTo: "/settings/credentials",
    };
  const shown = { canReadCredentials, hasTab: true, redirectTo: null };
  if (canReadCredentials === true) return shown;
  if (claudeCode.agent || claudeCode.isError) return shown;
  if (canReadCredentials === undefined || claudeCode.isPending) return unknown;
  return { canReadCredentials, hasTab: false, redirectTo: "/account" };
}
