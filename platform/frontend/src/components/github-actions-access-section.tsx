"use client";

import {
  DocsPage,
  GITHUB_ACTIONS_ACCESS_MAX_ENTRIES,
  GITHUB_JOB_WORKFLOW_REF_MESSAGE,
  GITHUB_JOB_WORKFLOW_REF_REGEX,
  GITHUB_REPOSITORY_FULL_NAME_MESSAGE,
  GITHUB_REPOSITORY_FULL_NAME_REGEX,
  type GitHubActionsAccess,
  GitHubActionsAccessSchema,
} from "@archestra/shared";
import { X } from "lucide-react";
import { type KeyboardEvent, useId, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { SettingsLink } from "@/components/settings-link";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  type RuntimeCredentialDefinition,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

/**
 * Which GitHub Actions pull-request jobs may use an MCP gateway as the pull
 * request's author. `null` turns it off.
 */
export function GitHubActionsAccessSection({
  value,
  onChange,
}: {
  value: GitHubActionsAccess | null;
  onChange: (value: GitHubActionsAccess | null) => void;
}) {
  const appName = useAppName();
  const switchId = useId();
  const appSelectId = useId();
  const { data: credentials = [] } = useRuntimeCredentials();
  const apps = credentials.filter(isGitHubComApp);
  const docsUrl = getFrontendDocsUrl(
    DocsPage.McpGatewayAuthentication,
    "github-actions",
  );
  const problem = gitHubActionsAccessError(value);

  return (
    <SettingsSection
      title="GitHub Actions"
      description="Pull request workflows that may use this gateway as the pull request's author."
    >
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id={switchId}
            checked={value !== null}
            onCheckedChange={(checked) =>
              onChange(
                checked
                  ? {
                      githubAppCredentialKey:
                        apps.length === 1 ? apps[0].key : "",
                      repositories: [],
                      workflows: [],
                    }
                  : null,
              )
            }
          />
          <Label htmlFor={switchId}>Accept GitHub Actions tokens</Label>
        </div>
        <FieldDescription>
          A trusted workflow on a pull request trades its GitHub OIDC token for
          a token on this gateway. It acts as the author, who must have
          connected GitHub to their {appName} account through the App below.
          {docsUrl ? (
            <>
              {" "}
              <ExternalDocsLink
                href={docsUrl}
                className="underline"
                showIcon={false}
              >
                Learn more
              </ExternalDocsLink>
            </>
          ) : null}
        </FieldDescription>
      </div>

      {value && (
        <>
          <div className="space-y-2">
            <Label htmlFor={appSelectId}>GitHub App</Label>
            <FieldDescription>
              The workflow posts its review as this App.
            </FieldDescription>
            {apps.length === 0 && !value.githubAppCredentialKey ? (
              <p className="text-sm text-muted-foreground">
                No GitHub App for GitHub.com yet. Add one under{" "}
                <SettingsLink
                  href="/settings/credentials"
                  className="underline"
                >
                  Credentials
                </SettingsLink>
                .
              </p>
            ) : (
              <Select
                value={value.githubAppCredentialKey || undefined}
                onValueChange={(githubAppCredentialKey) =>
                  onChange({ ...value, githubAppCredentialKey })
                }
              >
                <SelectTrigger id={appSelectId}>
                  <SelectValue placeholder="Select a GitHub App" />
                </SelectTrigger>
                <SelectContent>
                  {apps.map((app) => (
                    <SelectItem key={app.key} value={app.key}>
                      {app.name}
                    </SelectItem>
                  ))}
                  {/* A saved App this viewer cannot read stays selectable. */}
                  {value.githubAppCredentialKey &&
                    !apps.some(
                      (app) => app.key === value.githubAppCredentialKey,
                    ) && (
                      <SelectItem value={value.githubAppCredentialKey}>
                        {value.githubAppCredentialKey}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
            )}
          </div>

          <ListEditor
            label="Repositories"
            description="Pull requests in these repositories may ask. Pull requests from forks never can."
            placeholder="owner/name"
            values={value.repositories}
            pattern={GITHUB_REPOSITORY_FULL_NAME_REGEX}
            invalidMessage={GITHUB_REPOSITORY_FULL_NAME_MESSAGE}
            caseInsensitive
            onChange={(repositories) => onChange({ ...value, repositories })}
          />
          <ListEditor
            label="Trusted workflows"
            description="The workflow that asks for the token, as GitHub names it in the job_workflow_ref claim. Pin a branch, a tag, or a commit SHA."
            placeholder="owner/repo/.github/workflows/review.yml@refs/heads/main"
            values={value.workflows}
            pattern={GITHUB_JOB_WORKFLOW_REF_REGEX}
            invalidMessage={GITHUB_JOB_WORKFLOW_REF_MESSAGE}
            onChange={(workflows) => onChange({ ...value, workflows })}
          />
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** Why the setting cannot be saved yet, or null when it can. */
export function gitHubActionsAccessError(
  value: GitHubActionsAccess | null,
): string | null {
  if (!value) return null;
  if (!value.githubAppCredentialKey) return "Select a GitHub App";
  const parsed = GitHubActionsAccessSchema.safeParse(value);
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Check the GitHub Actions setting");
}

// ===================== Internals =====================

function isGitHubComApp(credential: RuntimeCredentialDefinition) {
  // GitHub Actions OIDC tokens come from GitHub.com.
  return (
    credential.kind === "github_app" &&
    credential.allowOrganization &&
    credential.githubUrl === "https://api.github.com" &&
    !!credential.appId &&
    !!credential.installationId
  );
}

function ListEditor({
  label,
  description,
  placeholder,
  values,
  pattern,
  invalidMessage,
  caseInsensitive = false,
  onChange,
}: {
  label: string;
  description: string;
  placeholder: string;
  values: string[];
  pattern: RegExp;
  invalidMessage: string;
  caseInsensitive?: boolean;
  onChange: (values: string[]) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const normalize = (entry: string) =>
    caseInsensitive ? entry.toLowerCase() : entry;

  const add = () => {
    const entry = draft.trim();
    if (!entry) return;
    if (!pattern.test(entry)) {
      setError(invalidMessage);
      return;
    }
    if (values.some((existing) => normalize(existing) === normalize(entry))) {
      setError(`${entry} is already listed`);
      return;
    }
    onChange([...values, entry]);
    setDraft("");
    setError(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    // Enter adds the entry; it never submits the surrounding form.
    event.preventDefault();
    add();
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <FieldDescription>{description}</FieldDescription>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((entry) => (
            <li key={entry}>
              <Badge variant="secondary" className="gap-1 pr-1 font-mono">
                <span className="break-all">{entry}</span>
                <UnstyledButton
                  aria-label={`Remove ${entry}`}
                  className="rounded-full p-0.5 outline-none hover:bg-destructive/20 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    onChange(values.filter((existing) => existing !== entry))
                  }
                >
                  <X className="size-3" />
                </UnstyledButton>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {values.length < GITHUB_ACTIONS_ACCESS_MAX_ENTRIES && (
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={draft}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onKeyDown={onKeyDown}
          />
          <Button
            type="button"
            variant="outline"
            onClick={add}
            disabled={!draft.trim()}
          >
            Add
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
