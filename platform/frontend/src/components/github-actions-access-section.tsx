"use client";

import {
  DocsPage,
  GITHUB_ACTIONS_ACCESS_MAX_ENTRIES,
  GITHUB_ACTIONS_REPOSITORY_MESSAGE,
  GITHUB_ACTIONS_REPOSITORY_REGEX,
  GITHUB_JOB_WORKFLOW_REF_MESSAGE,
  GITHUB_JOB_WORKFLOW_REF_REGEX,
  type GitHubActionsAccess,
  GitHubActionsAccessSchema,
  isGitHubActionsAppCredential,
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
  useCanAttachCredential,
  useCanUseEveryCredential,
  useRuntimeCredentials,
} from "@/lib/runtime-credentials.query";

/**
 * Which GitHub Actions pull-request jobs may use an MCP gateway, and as whom.
 * `null` turns it off.
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
  const actAsSelectId = useId();
  const resolveThreadsId = useId();
  const credentials = useRuntimeCredentials();
  const { data: canUseEveryCredential } = useCanUseEveryCredential();
  const canAttachCredential = useCanAttachCredential();
  // Saving needs `use` on the App, the same check the server makes.
  const apps = (credentials.data ?? []).filter(
    (credential) =>
      isGitHubActionsAppCredential(credential) &&
      canAttachCredential(credential.id),
  );
  // With no App in reach, say whether none exists or the editor may not use
  // one. A list the editor cannot read, or that grants item by item, may hide
  // an App they lack `use` on.
  const unavailable =
    apps.length > 0 || credentials.isPending
      ? null
      : credentials.isError || canUseEveryCredential !== true
        ? "permission"
        : "missing";
  const docsUrl = getFrontendDocsUrl(
    DocsPage.McpGatewayAuthentication,
    "github-actions",
  );
  const problem = gitHubActionsAccessError(value);

  return (
    <SettingsSection
      title="GitHub Actions"
      description="Pull request workflows that may use this gateway, and whose account they use."
    >
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id={switchId}
            checked={value !== null}
            // Turning it off never needs an App.
            disabled={value === null && apps.length === 0}
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
          a token on this gateway. It acts as one person, who must have
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
        {value === null && unavailable === "permission" && (
          <p className="text-sm text-muted-foreground">
            You need permission to use a GitHub App credential to turn this on.
          </p>
        )}
        {value === null && unavailable === "missing" && (
          <p className="text-sm text-muted-foreground">
            No GitHub App for GitHub.com yet. Add one under{" "}
            <SettingsLink href="/settings/credentials" className="underline">
              Credentials
            </SettingsLink>
            .
          </p>
        )}
      </div>

      {value && (
        <>
          <div className="space-y-2">
            <Label htmlFor={appSelectId}>GitHub App</Label>
            <FieldDescription>
              The workflow posts its review as this App.
            </FieldDescription>
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
                {/* A saved App this editor cannot use stays shown. */}
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
          </div>

          <div className="space-y-2">
            <Label htmlFor={actAsSelectId}>Runs act as</Label>
            <FieldDescription>
              Whose account a run uses. With whoever started the run, someone
              who asks for a review of another person's pull request uses their
              own account, and the trusted workflow decides whose runs to start.
            </FieldDescription>
            <Select
              value={value.actAs ?? "author"}
              onValueChange={(actAs) =>
                onChange({
                  ...value,
                  actAs: actAs === "actor" ? "actor" : undefined,
                })
              }
            >
              <SelectTrigger id={actAsSelectId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="author">
                  The pull request's author
                </SelectItem>
                <SelectItem value="actor">Whoever started the run</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Switch
                id={resolveThreadsId}
                checked={value.resolveReviewThreads === true}
                onCheckedChange={(checked) =>
                  onChange({
                    ...value,
                    resolveReviewThreads: checked ? true : undefined,
                  })
                }
              />
              <Label htmlFor={resolveThreadsId}>Resolve review threads</Label>
            </div>
            <FieldDescription>
              Gives each run's GitHub token Contents write, which GitHub
              requires to resolve a review thread. The App needs Contents write
              too; without it, runs still review.
            </FieldDescription>
          </div>

          <ListEditor
            label="Repositories"
            description="Pull requests in these repositories may ask; owner/* covers all of an owner's repositories. Pull requests from forks never can."
            placeholder="owner/name or owner/*"
            values={value.repositories}
            pattern={GITHUB_ACTIONS_REPOSITORY_REGEX}
            invalidMessage={GITHUB_ACTIONS_REPOSITORY_MESSAGE}
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
