"use client";

import {
  APP_RECORDING_VIEWPORT_ASPECT,
  type AppRecordingBundle,
  validateRecordingBundle,
} from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, ExternalLink, GitPullRequest, Lock } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
  AppSessionPlayer,
  useReviewPanelWidth,
} from "@/components/app-session-recording/app-session-player";
import { useAppSessionRecorder } from "@/components/app-session-recording/use-app-session-recorder";
import { useApps } from "@/components/chat/apps-context";
import { BrowserPanel } from "@/components/chat/browser-panel";
import { ConversationFilesPanel } from "@/components/chat/conversation-files-panel";
import { McpAppSection } from "@/components/chat/mcp-app-container";
import { ResizableRightPanel } from "@/components/chat/resizable-right-panel";
import { QueryLoadError } from "@/components/query-load-error";
import { ScheduleRunsList } from "@/components/scheduled-tasks/schedule-runs-list";
import type { ChatReviewContext } from "@/lib/chat/chat-review-context";
import { useScheduleTrigger } from "@/lib/schedule-trigger.query";

export type RightPanelTab = "runs" | "files" | "browser" | "apps" | "review";

interface RightSidePanelProps {
  isOpen: boolean;
  activeTab: RightPanelTab;
  onClose: () => void;
  canShowBrowser: boolean;

  /**
   * Set when the open chat is a scheduled run — enables the Runs tab, which
   * lists the schedule's runs and marks `runId` as current.
   */
  scheduledRun?: { triggerId: string; runId: string | null } | null;

  /**
   * Set when this chat is reviewing a hackathon submission — enables the Replay
   * tab, which docks the read-only session player (the submission's recording)
   * in the panel. Kept per-conversation in the review-context store.
   */
  reviewContext?: ChatReviewContext | null;

  // Artifact props
  artifact?: string | null;

  /** Set when the chat belongs to a project — enables the pinned instructions. */
  projectId?: string | null;

  // Browser props
  conversationId: string | undefined;
  /** Fallback agentId for pre-conversation case */
  agentId?: string;
  /** Called when user enters a URL without a conversation - should create conversation and navigate */
  onCreateConversationWithUrl?: (url: string) => void;
  /** Whether conversation creation is in progress */
  isCreatingConversation?: boolean;
  /** URL to navigate to once connected (after conversation creation) */
  initialNavigateUrl?: string;
  /** Called after initial navigation is triggered */
  onInitialNavigateComplete?: () => void;
}

export function RightSidePanel({
  isOpen,
  activeTab,
  onClose,
  canShowBrowser,
  scheduledRun,
  reviewContext,
  artifact,
  projectId,
  conversationId,
  agentId,
  onCreateConversationWithUrl,
  isCreatingConversation = false,
  initialNavigateUrl,
  onInitialNavigateComplete,
}: RightSidePanelProps) {
  const { setSettingsOpen } = useApps();
  // While a session recording runs, the panel is the recording surface: it
  // locks to the shape the replay player shows the app at, so the session is
  // captured at exactly the aspect it will play back at — one uniform scale,
  // no letterbox, no distortion. Inert (status stays "idle") outside a chat
  // page or when the recorder feature is off.
  const recorder = useAppSessionRecorder();

  // Width for the docked replay so the whole chat+app composite shows on open
  // instead of clipping. Computed window-only from the canonical two-card shape
  // (the recorder always captures at APP_RECORDING_VIEWPORT_ASPECT, so this
  // equals the recording's own width for every platform recording) — no bundle
  // fetch here, so the panel needs no QueryClient on non-review tabs. The docked
  // ReviewPanel fetches the bundle itself (it mounts only on the review tab).
  const reviewPanelWidth = useReviewPanelWidth(undefined);

  let resolvedTab: RightPanelTab = activeTab;
  if (resolvedTab === "browser" && !canShowBrowser) resolvedTab = "files";
  // The Runs tab only exists for scheduled-run chats; fall back otherwise.
  if (resolvedTab === "runs" && !scheduledRun) resolvedTab = "files";
  // The Replay tab only exists for submission-review chats; fall back otherwise.
  if (resolvedTab === "review" && !reviewContext) resolvedTab = "files";

  // Collapsing the panel drops the owned-app settings form so it reopens on the
  // live app, not the form. The tab strip (in the header) now drives collapse,
  // so reset here whenever the panel closes, regardless of how.
  useEffect(() => {
    if (!isOpen) {
      setSettingsOpen(false);
    }
  }, [isOpen, setSettingsOpen]);

  if (!isOpen) {
    return null;
  }

  // Content only — the Files/Browser/Apps/Runs tab strip lives in the header's
  // top bar now, so the panel just renders the selected tab's content.
  return (
    <ResizableRightPanel
      // Only the Apps tab is a recording surface — on any other tab the app
      // isn't hosted here (it falls back inline), so locking the panel would
      // squeeze Files/Browser content for nothing.
      aspectLock={
        recorder.status === "recording" && resolvedTab === "apps"
          ? {
              ratio: APP_RECORDING_VIEWPORT_ASPECT,
              hint: "App view is locked to the session player size while recording.",
            }
          : undefined
      }
      // On the Replay tab, open at the recording's own chat+app width so the
      // whole replay shows without clipping (still resizable). Other tabs keep
      // the shared saved width.
      preferredWidth={
        resolvedTab === "review" && reviewContext ? reviewPanelWidth : undefined
      }
    >
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {resolvedTab === "runs" && scheduledRun && (
          <RunsPanel
            triggerId={scheduledRun.triggerId}
            currentRunId={scheduledRun.runId}
            projectId={projectId ?? null}
          />
        )}
        {resolvedTab === "files" && (
          <ConversationFilesPanel
            key={conversationId ?? "none"}
            conversationId={conversationId}
            artifact={artifact}
            projectId={projectId}
            onClose={onClose}
          />
        )}
        {resolvedTab === "browser" && canShowBrowser && (
          <BrowserPanel
            isOpen
            onClose={onClose}
            conversationId={conversationId}
            agentId={agentId}
            onCreateConversationWithUrl={onCreateConversationWithUrl}
            isCreatingConversation={isCreatingConversation}
            initialNavigateUrl={initialNavigateUrl}
            onInitialNavigateComplete={onInitialNavigateComplete}
            hideHeader
          />
        )}
        {/* Apps tab content: renders the open app directly (no portal). The
            app-switcher lives in the hosted card's header (see McpAppCard). */}
        {resolvedTab === "apps" && <AppsPanelContent agentId={agentId} />}
        {/* Replay tab content: the docked read-only submission review player. */}
        {resolvedTab === "review" && reviewContext && (
          <ReviewPanel reviewContext={reviewContext} />
        )}
      </div>
    </ResizableRightPanel>
  );
}

/** onOpenChange has nowhere to go — the panel hosts the review player inline. */
const noopReviewOpenChange = () => {};

/**
 * Fetch a submission's recording bundle through the backend (so the browser CSP
 * never reaches GitHub), validated against the shared recording contract. Keyed
 * on `src`, so the panel's width owner (RightSidePanel) and the docked player
 * (ReviewPanel) share ONE request. Disabled when there is no `src`.
 */
function useReviewRecordingBundle(src: string | null | undefined) {
  return useQuery({
    queryKey: ["app-recording-review", src],
    enabled: !!src,
    // A bad `src` or an invalid bundle never comes good on retry; the error
    // state carries its own Retry button for the transient cases.
    retry: false,
    queryFn: async (): Promise<AppRecordingBundle> => {
      const response = await fetch(
        `/api/app-recording/review?src=${encodeURIComponent(src as string)}`,
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
      const validation = validateRecordingBundle(payload);
      if (!validation.ok) throw new Error(validation.reason);
      return validation.bundle;
    },
  });
}

/**
 * The Replay tab content: fetches the hackathon submission's recording bundle
 * (through the backend, so the browser CSP never reaches GitHub) and docks the
 * REAL read-only app-session player in the chat's right panel. A compact
 * submission header (app/author/PR/category + "Immutable review") frames the
 * player; the reviewer keeps the Hackathon agent's tools in the chat alongside.
 * Mirrors the full-page `/review` fetch, held to the same recording contract.
 * Exported so the chat page's inline mobile panel can mount it directly (the
 * same way it mounts `AppsPanelContent`), without the desktop resize frame.
 */
export function ReviewPanel({
  reviewContext,
}: {
  reviewContext: ChatReviewContext;
}) {
  const { sub, src, pr, repo, app, by, name, cat } = reviewContext;
  const prUrl =
    repo && pr ? `https://github.com/${repo}/pull/${pr}` : undefined;
  const authorUrl = by ? `https://github.com/${by}` : undefined;
  const displayName = app || "Hackathon submission";
  const authorLabel = name || by;

  const {
    data: bundle,
    isPending,
    isError,
    error,
    refetch,
  } = useReviewRecordingBundle(src);

  return (
    <div className="flex h-full flex-col">
      {/* Compact submission header — tight for the narrower panel. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <Lock className="size-3" />
          <span>Immutable review</span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="truncate font-semibold text-foreground">
            {displayName}
          </span>
          {authorUrl && authorLabel && (
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
            <span className="rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground">
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
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isError ? (
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
            onOpenChange={noopReviewOpenChange}
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

/**
 * The Apps tab content: the hosted app (or the no-apps empty state). Shared by
 * the desktop right panel and the chat page's inline mobile panel. While
 * mounted it registers as the apps portal target, which collapses inline app
 * renders in the chat and switches pill clicks to select-the-hosted-app mode —
 * so mount it only while the Apps tab is actually showing.
 */
export function AppsPanelContent({ agentId }: { agentId?: string }) {
  const { apps, setPortalTarget } = useApps();
  const portalDivRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setPortalTarget(portalDivRef.current);
    return () => {
      setPortalTarget(null);
    };
  }, [setPortalTarget]);

  return (
    <div className="flex flex-col h-full">
      <div ref={portalDivRef} className="flex-1 min-h-0 relative">
        {apps.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-xs text-muted-foreground px-6">
            <AppWindow className="h-6 w-6 mb-2 opacity-50" />
            <p className="font-medium">No Apps in this chat</p>
            <p className="mt-1">
              Apps from tool calls in this conversation will appear here.
            </p>
          </div>
        ) : (
          <PanelAppHost agentId={agentId} />
        )}
      </div>
    </div>
  );
}

/**
 * Renders the single hosted app (`panelToolCallId`) directly in the panel.
 * Switching the hosted app remounts via the key; the app-endpoint is rebuilt from
 * the list entry (owned apps need no extra data, external apps use the agent).
 */
function PanelAppHost({ agentId }: { agentId?: string }) {
  const { apps, panelToolCallId } = useApps();
  const app = apps.find((a) => a.toolCallId === panelToolCallId);
  if (!app) {
    return null;
  }

  // An external app drives the agent gateway; mounting a fresh iframe against an
  // empty agent (`/api/mcp/`) would 404, so bail like the inline render's guard.
  if (!app.appId && !app.mcpServerId && !agentId) {
    return null;
  }

  return (
    <McpAppSection
      key={app.toolCallId}
      surface="panel"
      uiResourceUri={app.uiResourceUri}
      agentId={agentId ?? ""}
      appId={app.appId ?? undefined}
      mcpServerId={app.mcpServerId}
      appName={app.label}
      appVersion={app.version}
      toolName={app.toolName ?? ""}
      toolCallId={app.toolCallId}
      rawOutput={app.rawOutput ?? undefined}
      toolInput={app.toolInput ?? undefined}
    />
  );
}

// Per-schedule runs-list scroll position. Selecting a run swaps the chat to the
// run's conversation; the page re-renders (and the panel can remount), which
// resets the list to the top. Remembering scrollTop here (module scope survives
// both) lets us restore it so the list stays where you left it after picking a run.
const runsScrollTopByTrigger = new Map<string, number>();

/** The Runs tab content: the schedule's runs, with the current run highlighted. */
function RunsPanel({
  triggerId,
  currentRunId,
  projectId,
}: {
  triggerId: string;
  currentRunId: string | null;
  projectId: string | null;
}) {
  const { data: trigger } = useScheduleTrigger(triggerId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Restore the saved scroll position whenever the panel (re)mounts OR the
  // selected run changes — selecting a run re-renders without remounting, so a
  // mount-only effect would miss it. Restore before paint, then re-assert next
  // frame in case the reset lands a frame late (content relayout).
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentRunId is a deliberate re-run trigger (restore on run selection), not read in the body.
  useLayoutEffect(() => {
    const saved = runsScrollTopByTrigger.get(triggerId);
    if (saved == null) {
      return;
    }
    if (scrollRef.current) {
      scrollRef.current.scrollTop = saved;
    }
    const raf = requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = saved;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [triggerId, currentRunId]);

  if (!projectId) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Runs are available for project schedules.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        runsScrollTopByTrigger.set(triggerId, e.currentTarget.scrollTop);
      }}
      className="flex h-full flex-col overflow-y-auto p-3"
    >
      <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Runs · {trigger?.name ?? "Schedule"}
      </div>
      <ScheduleRunsList triggerId={triggerId} currentRunId={currentRunId} />
    </div>
  );
}
