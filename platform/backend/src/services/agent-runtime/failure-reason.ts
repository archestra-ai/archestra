/** Decode only image-contract failure codes; never forward arbitrary pod output. */
export function agentRuntimeFailureReason(result: string): string {
  const [status, code] = result.trim().split(/\r?\n/).filter(Boolean);
  const exitStatus = /^\d{1,3}$/.test(status) ? status : "unknown";
  const detail = Object.hasOwn(FAILURE_REASONS, code)
    ? FAILURE_REASONS[code]
    : undefined;
  const fallback = `The Agent Runtime turn exited with status ${exitStatus}`;
  return detail ? `${detail} (Runtime exit status ${exitStatus}.)` : fallback;
}

// Codes are shared with maintained images and custom bootstrap wrappers.
// Keep messages static: raw CLI diagnostics can contain credentials.
const FAILURE_REASONS: Record<string, string> = {
  github_authentication:
    "GitHub rejected the credential. Reconnect the GitHub credential used by this run.",
  github_repository_access:
    "GitHub could not access the selected repository. Check the repository name, token repository access, and GitHub App installation access.",
  github_permissions:
    "GitHub denied access. Check token permissions and organization access policies.",
  github_sso:
    "GitHub requires SSO authorization. Authorize the credential for the organization.",
  github_rate_limit: "GitHub rate limit reached. Retry later.",
  github_unavailable:
    "GitHub could not be reached. Check runner network access and retry.",
  github_configuration:
    "GitHub authentication could not be configured. Check the runtime image and GitHub connection.",
  repository_setup:
    "Repository setup failed. Check repository access and the run terminal for the failed setup step.",
  claude_authentication:
    "Claude Code authentication failed. Reconnect your Claude Code account for subscription runs, or check the configured provider credential.",
  claude_billing:
    "Claude Code could not use the account. Check its billing status and organization access.",
  claude_rate_limit:
    "Claude Code reached a rate limit. Retry when account capacity is available.",
  claude_unavailable:
    "Claude Code could not complete the API request. The provider may be temporarily unavailable; retry later.",
  claude_request:
    "Claude Code rejected the request. Check the configured model and account access.",
  claude_api_error:
    "Claude Code ended the turn after an API error. Inspect the run terminal for details.",
};
