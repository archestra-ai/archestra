"use client";

import { DEFAULT_GIT_WEB_URLS, type GitProvider } from "@archestra/shared";
import {
  AlertTriangle,
  BookMarked,
  Globe,
  LoaderCircle,
  Lock,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useGitCredentialRepositories } from "@/lib/git-credentials.query";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { AdvancedFold, GitProviderLogo } from "./git-setup-chrome";
import { type GitAccess, resolveGitRepository } from "./git-source";

export interface GitRepositoryValue {
  /** A path picked from the list, or whatever was pasted: path or URL. */
  input: string;
  /** Picked from the list rather than pasted. */
  picked: boolean;
  ref: string;
  subpath: string;
}

export const EMPTY_GIT_REPOSITORY: GitRepositoryValue = {
  input: "",
  picked: false,
  ref: "",
  subpath: "",
};

/**
 * Which repository to read: picked from what the credential can see, or
 * pasted as a path or URL. Branch and folder wait under Advanced.
 */
export function GitRepositoryStep({
  provider,
  access,
  value,
  onChange,
  onChangeAccess,
  withSubpath = false,
  subpathPlaceholder = "skills",
}: {
  provider: GitProvider;
  access: GitAccess;
  value: GitRepositoryValue;
  onChange: (value: GitRepositoryValue) => void;
  /** Back to the access step. */
  onChangeAccess: () => void;
  /** Offer a folder inside the repository under Advanced. */
  withSubpath?: boolean;
  subpathPlaceholder?: string;
}) {
  const credentialId =
    access.kind === "credential" ? access.credential.id : null;
  const [search, setSearch] = useState("");
  const repositories = useGitCredentialRepositories({
    credentialId,
    search: useDebouncedValue(search, 300),
  });
  const [advanced, setAdvanced] = useState(
    !!value.ref.trim() || !!value.subpath.trim(),
  );
  const resolved = resolveGitRepository({
    provider,
    access,
    input: value.input,
  });
  const project = provider === "gitlab" ? "project" : "repository";
  const cloudHost = new URL(DEFAULT_GIT_WEB_URLS[provider]).host;
  const placeholder =
    provider === "gitlab"
      ? `${cloudHost}/group/project`
      : `${cloudHost}/owner/repo`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
        {access.kind === "credential" ? (
          <GitProviderLogo provider={provider} size={14} />
        ) : (
          <Globe className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate font-medium">
          {access.kind === "credential"
            ? access.credential.name
            : `Public ${project}`}
        </span>
        <span className="truncate text-muted-foreground">
          {access.kind === "credential"
            ? new URL(access.credential.webUrl).host
            : cloudHost}
        </span>
        <Button
          type="button"
          variant="link"
          size="xs"
          className="ml-auto h-auto px-0 text-xs text-muted-foreground"
          onClick={onChangeAccess}
        >
          <span>Change</span>
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor={credentialId ? "git-repo-pick" : "git-repo-url"}>
          {provider === "gitlab" ? "Project" : "Repository"}
        </Label>
        {credentialId ? (
          repositories.isPending ? (
            <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              <span>Loading…</span>
            </div>
          ) : (
            <SearchableSelect
              id="git-repo-pick"
              className="w-full"
              value={value.picked ? value.input : ""}
              onValueChange={(path) =>
                onChange({ ...value, input: path, picked: true })
              }
              onSearchQueryChange={setSearch}
              placeholder={`Choose a ${project}`}
              searchPlaceholder="Search…"
              hint={repositories.isFetching ? "Searching…" : undefined}
              emptyMessage={
                repositories.isError
                  ? repositories.error.message
                  : `No ${project} matches.`
              }
              listClassName="max-h-72"
              items={(repositories.data ?? []).map((repository) => ({
                value: repository.path,
                label: repository.path,
                content: <RepositoryOption repository={repository} />,
              }))}
            />
          )
        ) : null}
        <Input
          id="git-repo-url"
          aria-label={credentialId ? "Repository URL" : undefined}
          value={value.picked ? "" : value.input}
          placeholder={credentialId ? "or paste a URL" : placeholder}
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          spellCheck={false}
          autoFocus={!credentialId}
          aria-invalid={!resolved.ok && !!resolved.error}
          onChange={(event) =>
            onChange({ ...value, input: event.target.value, picked: false })
          }
        />
        {!resolved.ok && resolved.error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{resolved.error}</span>
          </p>
        ) : null}
      </div>

      <AdvancedFold
        open={advanced}
        onOpenChange={setAdvanced}
        hint={withSubpath ? "(branch, folder)" : "(branch)"}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="git-repo-ref">Branch</Label>
            <Input
              id="git-repo-ref"
              value={value.ref}
              placeholder="Default branch"
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              onChange={(event) =>
                onChange({ ...value, ref: event.target.value })
              }
            />
          </div>
          {withSubpath ? (
            <div className="space-y-2">
              <Label htmlFor="git-repo-subpath">Folder</Label>
              <Input
                id="git-repo-subpath"
                value={value.subpath}
                placeholder={subpathPlaceholder}
                autoComplete="off"
                data-1p-ignore
                spellCheck={false}
                onChange={(event) =>
                  onChange({ ...value, subpath: event.target.value })
                }
              />
            </div>
          ) : null}
        </div>
      </AdvancedFold>
    </div>
  );
}

// ===================== Internals =====================

/** A row: namespace dimmed, name bold, a lock when private. */
function RepositoryOption({
  repository,
}: {
  repository: { path: string; private: boolean };
}) {
  const slash = repository.path.lastIndexOf("/");
  const Icon = repository.private ? Lock : BookMarked;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">
        <span className="text-muted-foreground">
          {repository.path.slice(0, slash + 1)}
        </span>
        <span className="font-medium">{repository.path.slice(slash + 1)}</span>
      </span>
    </span>
  );
}
