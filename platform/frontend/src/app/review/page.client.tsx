"use client";

import {
  type AppRecordingBundle,
  validateRecordingBundle,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, GitPullRequest, Lock } from "lucide-react";
import { useEffect } from "react";
import { AppSessionPlayer } from "@/components/app-session-recording/app-session-player";
import { QueryLoadError } from "@/components/query-load-error";

/** onOpenChange has nowhere to go — the review player IS the page. */
const noop = () => {};

interface ReviewPageProps {
  sub?: string;
  src?: string;
  pr?: string;
  repo?: string;
  app?: string;
  by?: string;
  name?: string;
  cat?: string;
}

/**
 * The on-platform, authenticated host for reviewing a hackathon submission: it
 * fetches the submission's recording bundle from GitHub (through the backend, so
 * the browser CSP never reaches GitHub) and mounts the REAL app-session player
 * in read-only review mode. The banner, submission metadata and reviewer note
 * frame the player; the actual decision happens on the PR / Slack card.
 */
export default function ReviewPage({
  sub,
  src,
  pr,
  repo,
  app,
  by,
  name,
  cat,
}: ReviewPageProps) {
  const prUrl =
    repo && pr ? `https://github.com/${repo}/pull/${pr}` : undefined;
  const authorUrl = by ? `https://github.com/${by}` : undefined;
  // Link params (from the hackathon MCP): `app` is the app's display name,
  // `name` is the author's display name, `by` is the author's github login.
  const displayName = app || "Hackathon submission";
  const authorLabel = name || by;

  useEffect(() => {
    document.title = `Review · ${displayName}`;
  }, [displayName]);

  const {
    data: bundle,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["app-recording-review", src],
    enabled: !!src,
    // A bad `src` or an invalid bundle will never come good on retry, and the
    // error state carries its own Retry button for the transient cases.
    retry: false,
    queryFn: async (): Promise<AppRecordingBundle> => {
      if (!src)
        throw new Error("This review link is missing its recording source.");
      const response = await fetch(
        `/api/app-recording/review?src=${encodeURIComponent(src)}`,
        { credentials: "include", headers: { accept: "application/json" } },
      );
      if (!response.ok) {
        let message = `Couldn't load this submission (HTTP ${response.status}).`;
        try {
          const body = (await response.json()) as {
            error?: { message?: string };
          };
          if (body?.error?.message) message = body.error.message;
        } catch {
          // Non-JSON error body — keep the status-based fallback message.
        }
        throw new Error(message);
      }
      const payload = await response.json();
      // Held to the same contract the player enforces, so a malformed bundle
      // fails here with a reason rather than as a broken replay.
      const validation = validateRecordingBundle(payload);
      if (!validation.ok) throw new Error(validation.reason);
      return validation.bundle;
    },
  });

  return (
    <div className="flex h-app-viewport w-full flex-col bg-background">
      {/* Immutable-review banner — the surface's identity. */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground">
        <Lock className="size-3.5" />
        <span>Immutable review · hackathon submission</span>
      </div>

      {/* Submission metadata + reviewer note. */}
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="truncate font-semibold text-foreground">
            {displayName}
          </span>
          {authorUrl && (
            <a
              href={authorUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              by {authorLabel}
              <ExternalLink className="size-3" />
            </a>
          )}
          {cat && (
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
              {cat}
            </span>
          )}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
            >
              <GitPullRequest className="size-3.5" />
              {pr ? `PR #${pr}` : "Pull request"}
            </a>
          )}
        </div>
        <p className="max-w-xl text-xs text-muted-foreground">
          Read-only replay. Nothing here changes the submission — the decision
          happens on the{" "}
          {prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground hover:underline"
            >
              pull request
            </a>
          ) : (
            <span>pull request</span>
          )}{" "}
          / Slack card.
        </p>
      </div>

      {/* The player gets the whole remaining page. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!src ? (
          <QueryLoadError
            title="This review link is incomplete"
            description="It has no recording source (src). Reopen it from the submission's PR or Slack card."
            onRetry={noop}
          />
        ) : isError ? (
          <QueryLoadError
            title="Couldn't load this submission"
            description={
              error instanceof Error
                ? error.message
                : "The submission recording could not be fetched."
            }
            onRetry={() => refetch()}
          />
        ) : isPending ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading submission…
          </div>
        ) : (
          <AppSessionPlayer
            open
            onOpenChange={noop}
            review={{
              bundle,
              submission: {
                sub: sub || src,
                pr,
                repo,
                app,
                by,
                name,
                cat,
                prUrl,
              },
            }}
          />
        )}
      </div>
    </div>
  );
}
