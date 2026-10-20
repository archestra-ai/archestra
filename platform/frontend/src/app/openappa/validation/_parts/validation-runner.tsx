"use client";

import type { OpenAppaValidationProgressMessage } from "@archestra/shared";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import websocketService from "@/lib/websocket/websocket";
import { validationName } from "../../_parts/validation-run-history";
import { useValidation, validationFileHref } from "./validation-context";
import {
  type RunnerCounts,
  type RunnerFile,
  ValidationRunnerPanel,
} from "./validation-runner-panel";

/**
 * Follows "Run all" live in a panel docked under the page, and shows recorded
 * runs from history in the same panel. Progress arrives over the WebSocket for
 * the token sent with the run request; the HTTP response fills in whatever the
 * socket missed, so the panel still completes without a live connection.
 */
export function ValidationRunnerProvider({
  children,
}: {
  children: ReactNode;
}) {
  const suite = useValidation();
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [open, setOpen] = useState(false);

  // Follow the live session's progress events.
  const token = session?.mode === "live" ? session.token : null;
  useEffect(() => {
    if (!token) return;
    return websocketService.subscribe(
      "openappa_validation_progress",
      (message) => {
        if (message.payload.token !== token) return;
        setSession((current) =>
          current?.token === token
            ? applyProgress(current, message.payload)
            : current,
        );
      },
    );
  }, [token]);

  const names = useMemo(
    () =>
      Object.fromEntries(
        suite.files.map((file) => [file.path, validationName(file)]),
      ),
    [suite.files],
  );

  /** Starts a run of `paths` (every file when omitted) and follows it live. */
  const startRun = useCallback(
    (paths?: string[]) => {
      const progressToken = crypto.randomUUID();
      const options = {
        progressToken,
        onSettled: (run: PolicyTestRun | null, error: Error | null) =>
          setSession((current) =>
            current?.token === progressToken
              ? settle(current, run, error)
              : current,
          ),
      };
      const started =
        paths?.length === 1
          ? suite.runFile(paths[0], options)
          : suite.runAll(options);
      if (!started) return;
      setSession({
        key: Date.now(),
        token: progressToken,
        mode: "live",
        paths: paths ?? suite.files.map((file) => file.path),
        results: {},
        fileStartedAt: {},
        running: null,
        startedAt: Date.now(),
        finishedAt: null,
        run: null,
        error: null,
      });
      setOpen(true);
    },
    [suite],
  );
  const startRunAll = useCallback(() => startRun(), [startRun]);
  const startRunFile = useCallback(
    (path: string) => startRun([path]),
    [startRun],
  );

  const openRun = useCallback((run: PolicyTestRun) => {
    setSession(recordedSession(run));
    setOpen(true);
  }, []);

  // Keep the panel across a page refresh: remember which run it shows, and
  // reopen that run (or the newest one, for a live run cut short) on load.
  const shownRunId = session && open ? (session.run?.id ?? LATEST_RUN) : null;
  const runs = suite.history.data;
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (restored) writeShownRun(shownRunId);
  }, [restored, shownRunId]);
  useEffect(() => {
    if (restored || !runs) return;
    setRestored(true);
    const id = readShownRun();
    const run =
      id === LATEST_RUN ? runs[0] : runs.find((item) => item.id === id);
    if (run) openRun(run);
  }, [restored, runs, openRun]);

  const value = useMemo(
    () => ({ startRunAll, startRunFile, openRun }),
    [startRunAll, startRunFile, openRun],
  );

  return (
    <ValidationRunnerContext.Provider value={value}>
      {children}
      {session && (
        <RunnerHost
          key={session.key}
          session={session}
          names={names}
          open={open}
          canRunAgain={suite.runnable && suite.files.length > 0}
          onClose={() => {
            setOpen(false);
            // Let the exit animation play before the panel unmounts.
            setTimeout(
              () =>
                setSession((current) =>
                  current?.key === session.key ? null : current,
                ),
              250,
            );
          }}
          onRunAgain={startRunAll}
          onOpenFile={(path) => {
            setOpen(false);
            router.push(validationFileHref(path));
          }}
          onOpenHistory={() => {
            setOpen(false);
            router.push("/openappa/validation/history");
          }}
        />
      )}
    </ValidationRunnerContext.Provider>
  );
}

export function useValidationRunner() {
  const runner = useContext(ValidationRunnerContext);
  if (!runner)
    throw new Error(
      "useValidationRunner must be used inside ValidationRunnerProvider",
    );
  return runner;
}

// ===========================================================================
// Internal helpers
// ===========================================================================

type FileResult = Omit<
  PolicyTestRun["files"][number],
  "contentHash" | "durationMs"
> & { durationMs: number | null };

type Session = {
  key: number;
  token: string | null;
  mode: "live" | "replay";
  paths: string[];
  results: Record<string, FileResult>;
  fileStartedAt: Record<string, number>;
  running: string | null;
  startedAt: number;
  finishedAt: number | null;
  run: PolicyTestRun | null;
  /** Why a live run ended without a recorded run. */
  error: string | null;
};

type ProgressPayload = OpenAppaValidationProgressMessage["payload"];

const ValidationRunnerContext = createContext<{
  startRunAll: () => void;
  startRunFile: (path: string) => void;
  openRun: (run: PolicyTestRun) => void;
} | null>(null);

const SHOWN_RUN_KEY = "openappa-validation-runner";
const LATEST_RUN = "latest";

function readShownRun() {
  try {
    return sessionStorage.getItem(SHOWN_RUN_KEY);
  } catch {
    return null;
  }
}

function writeShownRun(id: string | null) {
  try {
    if (id) sessionStorage.setItem(SHOWN_RUN_KEY, id);
    else sessionStorage.removeItem(SHOWN_RUN_KEY);
  } catch {
    // Storage can be unavailable; the panel just won't survive a refresh.
  }
}

function applyProgress(session: Session, payload: ProgressPayload): Session {
  if (session.finishedAt !== null) return session;
  switch (payload.phase) {
    case "started":
      return { ...session, paths: payload.paths };
    case "file_started":
      return {
        ...session,
        running: payload.path,
        fileStartedAt: { ...session.fileStartedAt, [payload.path]: Date.now() },
      };
    case "file_finished":
      return {
        ...session,
        running: session.running === payload.path ? null : session.running,
        results: {
          ...session.results,
          [payload.path]: {
            path: payload.path,
            status: payload.status,
            assertionCount: payload.assertionCount,
            error: payload.error ?? null,
            steps: payload.steps,
            durationMs: payload.durationMs,
          },
        },
      };
    case "finished":
      // The HTTP response carries the recorded run; wait for it to settle.
      return session;
  }
}

function settle(
  session: Session,
  run: PolicyTestRun | null,
  error: Error | null,
): Session {
  const results = { ...session.results };
  for (const file of run?.files ?? []) {
    results[file.path] = {
      ...file,
      // Keep the duration the socket measured when the record has none.
      durationMs: file.durationMs ?? results[file.path]?.durationMs ?? null,
    };
  }
  return {
    ...session,
    paths: run ? run.files.map((file) => file.path) : session.paths,
    results,
    running: null,
    finishedAt: Date.now(),
    run,
    error: run ? null : (error?.message ?? null),
  };
}

function recordedSession(run: PolicyTestRun): Session {
  const startedAt = new Date(run.createdAt).getTime();
  const total = run.files.reduce(
    (sum, file) => sum + (file.durationMs ?? 0),
    0,
  );
  return {
    key: Date.now(),
    token: null,
    mode: "replay",
    paths: run.files.map((file) => file.path),
    results: Object.fromEntries(
      run.files.map((file) => [
        file.path,
        { ...file, durationMs: file.durationMs ?? null },
      ]),
    ),
    fileStartedAt: {},
    running: null,
    startedAt,
    finishedAt: startedAt + total,
    run,
    error: null,
  };
}

function RunnerHost({
  session,
  names,
  open,
  canRunAgain,
  onClose,
  onRunAgain,
  onOpenFile,
  onOpenHistory,
}: {
  session: Session;
  names: Record<string, string>;
  open: boolean;
  canRunAgain: boolean;
  onClose: () => void;
  onRunAgain: () => void;
  onOpenFile: (path: string) => void;
  onOpenHistory: () => void;
}) {
  const done = session.finishedAt !== null;
  const [now, setNow] = useState(() => Date.now());
  // Mount closed, then open next frame so the panel slides in.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [done]);

  const files = session.paths.map((path): RunnerFile => {
    const result = session.results[path];
    if (result)
      return {
        path,
        name: names[path] ?? path,
        status: result.status,
        steps: result.steps,
        revealedSteps: result.steps.length,
        assertionCount: result.assertionCount,
        error: result.error ?? null,
        durationMs: result.durationMs,
        slow: false,
      };
    const startedAt = session.fileStartedAt[path];
    const running = !done && session.running === path;
    return {
      path,
      name: names[path] ?? path,
      status: running ? "running" : "queued",
      steps: [],
      revealedSteps: 0,
      assertionCount: 0,
      error: null,
      durationMs: running && startedAt ? now - startedAt : null,
      slow: false,
    };
  });
  const counts = files.reduce<RunnerCounts>(
    (acc, file) => {
      acc[file.status] += 1;
      return acc;
    },
    {
      queued: 0,
      running: 0,
      passed: 0,
      failed: 0,
      cannot_run: 0,
      total: files.length,
    },
  );
  const elapsedMs = (session.finishedAt ?? now) - session.startedAt;

  return (
    <ValidationRunnerPanel
      open={open && shown}
      onClose={onClose}
      mode={session.mode}
      run={session.run}
      error={session.error}
      startedAt={new Date(session.startedAt).toISOString()}
      files={files}
      counts={counts}
      done={done}
      elapsedMs={
        session.mode === "replay" &&
        files.every((file) => file.durationMs === null)
          ? null
          : Math.max(0, elapsedMs)
      }
      onRunAgain={onRunAgain}
      canRunAgain={canRunAgain}
      onOpenFile={onOpenFile}
      onOpenHistory={onOpenHistory}
    />
  );
}
