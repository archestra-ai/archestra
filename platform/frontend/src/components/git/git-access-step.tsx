"use client";

import {
  DEFAULT_GIT_WEB_URLS,
  GIT_PROVIDER_LABELS,
  type GitProvider,
} from "@archestra/shared";
import {
  AlertTriangle,
  ExternalLink,
  Globe,
  LoaderCircle,
  Plus,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { SecretInput } from "@/components/ui/secret-input";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type GitCredential,
  useCreateGitlabToken,
  useGitCredentials,
} from "@/lib/git-credentials.query";
import { cn } from "@/lib/utils/tailwind";
import { GitProviderLogo } from "./git-setup-chrome";
import { type GitAccess, selfHostedLabel } from "./git-source";

/**
 * How a Git setup signs in: a GitHub App or GitLab token the organization
 * saved, or none for a public repository. GitLab tokens can be added here;
 * GitHub Apps are created in Settings.
 */
export function GitAccessStep({
  provider,
  access,
  onAccessChange,
  allowPublic = true,
}: {
  provider: GitProvider;
  access: GitAccess | null;
  onAccessChange: (access: GitAccess | null) => void;
  /** Off where the feature writes to the repository (OpenAPPA). */
  allowPublic?: boolean;
}) {
  const { data: canRead } = useHasPermissions({ credential: ["read"] });
  const { data: canCreate } = useHasPermissions({ credential: ["create"] });
  const credentials = useGitCredentials(canRead === true);
  const options =
    credentials.data?.filter((entry) => entry.provider === provider) ?? [];
  const [adding, setAdding] = useState(false);
  const loading = canRead === undefined || (canRead && credentials.isPending);

  // Start on the first saved credential, or on public when there is none.
  const firstOption = options[0];
  useEffect(() => {
    if (access || loading || adding) return;
    if (firstOption)
      onAccessChange({ kind: "credential", credential: firstOption });
    else if (allowPublic) onAccessChange({ kind: "public" });
  }, [access, loading, adding, firstOption, allowPublic, onAccessChange]);

  if (loading)
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        <span>Loading…</span>
      </p>
    );

  const value = adding
    ? NEW
    : access?.kind === "public"
      ? PUBLIC
      : (access?.credential.id ?? "");
  const label = GIT_PROVIDER_LABELS[provider];
  const canAddToken = provider === "gitlab" && canCreate === true;

  return (
    <div className="space-y-3">
      {credentials.isError ? (
        <InlineNotice variant="error">
          <AlertTriangle aria-hidden />
          <span className="font-medium">Couldn't load credentials</span>
          <InlineNoticeText className="flex-1">
            {credentials.error.message}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
      <RadioGroup
        value={value}
        onValueChange={(next) => {
          if (next === NEW) {
            setAdding(true);
            onAccessChange(null);
            return;
          }
          setAdding(false);
          if (next === PUBLIC) return onAccessChange({ kind: "public" });
          const credential = options.find((entry) => entry.id === next);
          if (credential) onAccessChange({ kind: "credential", credential });
        }}
        className="gap-2"
        aria-label={`${label} access`}
      >
        {options.map((credential) => (
          <AccessOption
            key={credential.id}
            value={credential.id}
            icon={<GitProviderLogo provider={provider} />}
            title={credential.name}
            badge={selfHostedLabel(credential.webUrl, provider)}
          />
        ))}
        {allowPublic ? (
          <AccessOption
            value={PUBLIC}
            icon={<Globe className="size-4 text-muted-foreground" />}
            title={
              provider === "gitlab" ? "Public project" : "Public repository"
            }
            hint={`On ${new URL(DEFAULT_GIT_WEB_URLS[provider]).host}. No sign-in.`}
          />
        ) : null}
        {canAddToken ? (
          <AccessOption
            value={NEW}
            icon={<Plus className="size-4 text-muted-foreground" />}
            title="Add a GitLab token"
          />
        ) : null}
      </RadioGroup>

      {adding ? (
        <GitlabTokenForm
          onSaved={(credential) => {
            setAdding(false);
            onAccessChange({ kind: "credential", credential });
          }}
        />
      ) : null}

      {provider === "github" ? (
        <p className="text-xs text-muted-foreground">
          {options.length ? (
            <span>Need another App? </span>
          ) : (
            <span>No GitHub Apps yet. </span>
          )}
          <Link
            href="/settings/credentials"
            target="_blank"
            className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
          >
            <span>Add one in Settings</span>
            <ExternalLink className="size-3" aria-hidden />
          </Link>
        </p>
      ) : !canAddToken && !options.length ? (
        <p className="text-xs text-muted-foreground">
          Ask an admin to add a GitLab token.
        </p>
      ) : null}
    </div>
  );
}

// ===================== Internals =====================

const PUBLIC = "public";
const NEW = "new";

function AccessOption({
  value,
  icon,
  title,
  hint,
  badge,
}: {
  value: string;
  icon: ReactNode;
  title: string;
  hint?: string;
  badge?: string | null;
}) {
  const id = `git-access-${value}`;
  return (
    <Label
      htmlFor={id}
      className={cn(
        radioCardClass(),
        "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-normal",
      )}
    >
      <RadioGroupItem value={value} id={id} />
      <span className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        {hint ? (
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
      {badge ? (
        <Badge
          variant="outline"
          className="bg-background font-mono font-normal"
        >
          {badge}
        </Badge>
      ) : null}
    </Label>
  );
}

/** Save a GitLab token for the organization; GitLab checks it first. */
function GitlabTokenForm({
  onSaved,
}: {
  onSaved: (credential: GitCredential) => void;
}) {
  const create = useCreateGitlabToken();
  const [name, setName] = useState("");
  const [url, setUrl] = useState(DEFAULT_GIT_WEB_URLS.gitlab);
  const [token, setToken] = useState("");
  const host = hostOf(url);
  const defaultName =
    host && host !== "gitlab.com" ? `GitLab (${host})` : "GitLab";

  function save() {
    create.mutate(
      {
        name: name.trim() || defaultName,
        gitlabUrl: url.trim() || DEFAULT_GIT_WEB_URLS.gitlab,
        token: token.trim(),
      },
      { onSuccess: (created) => created && onSaved(created) },
    );
  }

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gitlab-token-url">GitLab URL</Label>
          <Input
            id="gitlab-token-url"
            value={url}
            placeholder={DEFAULT_GIT_WEB_URLS.gitlab}
            autoComplete="off"
            data-1p-ignore
            spellCheck={false}
            aria-invalid={!host}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gitlab-token-name">Name</Label>
          <Input
            id="gitlab-token-name"
            value={name}
            placeholder={defaultName}
            autoComplete="off"
            data-1p-ignore
            onChange={(event) => setName(event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="gitlab-token-value">Token</Label>
        <FieldDescription>
          <span>Project, group, or personal access token with the </span>
          <code className="font-mono">api</code>
          <span> scope (</span>
          <code className="font-mono">read_api</code>
          <span> to only read).</span>
        </FieldDescription>
        <div className="flex gap-2">
          <SecretInput
            id="gitlab-token-value"
            value={token}
            placeholder="glpat-…"
            className="flex-1"
            onChange={(event) => setToken(event.target.value)}
          />
          <Button
            type="button"
            disabled={!token.trim() || !host || create.isPending}
            onClick={save}
          >
            {create.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : null}
            <span>{create.isPending ? "Checking…" : "Save token"}</span>
          </Button>
        </div>
      </div>
      {create.error ? (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{create.error.message}</span>
        </p>
      ) : null}
    </div>
  );
}

function hostOf(value: string): string | null {
  const raw = value.trim() || DEFAULT_GIT_WEB_URLS.gitlab;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.includes(".") || url.hostname === "localhost"
      ? url.host
      : null;
  } catch {
    return null;
  }
}
