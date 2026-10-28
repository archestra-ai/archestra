"use client";

import { parseGithubAccountInput } from "@archestra/shared";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/tailwind";

/** github.com's address, the GitHub URL field's default. */
export const GITHUB_DOT_COM_WEB = "https://github.com";

/**
 * The GitHub account every GitHub App setup starts from: the GitHub it lives
 * on (github.com or a GitHub Enterprise Server) and the organization there.
 * An error replaces its field's description, so nothing moves.
 */
export function GithubAccountFields({
  idPrefix,
  githubUrl,
  onGithubUrlChange,
  organization,
  onOrganizationChange,
  organizationHelp,
  urlError,
  organizationError,
  disabled = false,
}: {
  idPrefix: string;
  githubUrl: string;
  onGithubUrlChange: (value: string) => void;
  organization: string;
  onOrganizationChange: (value: string) => void;
  /** What the organization is for, e.g. where the policy repository lives. */
  organizationHelp: string;
  urlError: string | null;
  organizationError: string | null;
  /** Shown but fixed, e.g. a connected plan's account. */
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <AccountField
        id={`${idPrefix}-host`}
        label="GitHub URL"
        help="Using GitHub Enterprise Server? Put its address here."
        error={urlError}
        value={githubUrl}
        placeholder={GITHUB_DOT_COM_WEB}
        disabled={disabled}
        onChange={onGithubUrlChange}
      />
      <AccountField
        id={`${idPrefix}-owner`}
        label="Organization"
        help={organizationHelp}
        error={organizationError}
        value={organization}
        placeholder="acme"
        disabled={disabled}
        onChange={onOrganizationChange}
      />
    </div>
  );
}

/**
 * Read the two fields: the account they name, its one-string form for the
 * backend (a login on github.com, else `<GitHub URL>/<login>`), and what is
 * wrong with each field.
 */
export function readGithubAccountFields(fields: {
  githubUrl: string;
  organization: string;
  /** Refuse a GitHub reached over plain http. */
  httpsOnly?: boolean;
}) {
  const parsed = parseGithubUrl(fields.githubUrl);
  const insecure = !!parsed && fields.httpsOnly === true && !parsed.https;
  const host = insecure ? null : parsed;
  const login = ownerFromInput(fields.organization);
  const loginValid = OWNER_PATTERN.test(login);
  const input = host
    ? host.dotCom
      ? login
      : `${host.web}/${login}`
    : fields.organization.trim();
  return {
    account: host && loginValid ? parseGithubAccountInput(input) : null,
    input,
    urlError: insecure ? URL_NOT_HTTPS : host ? null : URL_INVALID,
    organizationError:
      fields.organization.trim() && !loginValid ? ORGANIZATION_INVALID : null,
  };
}

// ===== Internal helpers =====

const URL_INVALID = "Enter a web address, like https://github.com.";
const URL_NOT_HTTPS = "Use an https:// address for GitHub.";
const ORGANIZATION_INVALID = "Enter the organization's name on GitHub.";
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

function AccountField(props: {
  id: string;
  label: string;
  help: string;
  error: string | null;
  value: string;
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={props.id}>{props.label}</Label>
      <FieldDescription
        id={`${props.id}-help`}
        // One line, error or not, so the two columns stay aligned.
        className={cn("truncate", props.error && "text-destructive")}
        title={props.error ?? undefined}
        role={props.error ? "alert" : undefined}
      >
        {props.error ?? props.help}
      </FieldDescription>
      <Input
        id={props.id}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete="off"
        data-1p-ignore
        spellCheck={false}
        disabled={props.disabled}
        aria-invalid={!!props.error}
        aria-describedby={`${props.id}-help`}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

/** A GitHub address becomes its web origin; any path is ignored. */
function parseGithubUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname.includes(".")
  )
    return null;
  return {
    dotCom: url.hostname === "github.com",
    web: url.origin,
    https: url.protocol === "https:",
  };
}

/** A pasted profile or repository URL names its owner: github.com/acme/repo is acme. */
function ownerFromInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return trimmed;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    return url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return trimmed;
  }
}
