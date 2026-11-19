"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type PolicyTestCollection,
  type PolicyTestInspection,
  type PolicyTestRun,
  useInspectOpenAppaPolicyTests,
  useOpenAppaPolicyTestRuns,
  useOpenAppaPolicyTests,
  useRunOpenAppaPolicyTests,
  useSaveOpenAppaPolicyTests,
} from "@/lib/openappa-policy-tests.query";

export type ValidationSuite = ReturnType<typeof useSuite>;
const ValidationContext = createContext<ValidationSuite | null>(null);

/**
 * The organization's validation files with their runs, for the Policy page.
 * It never stands in the page's way: `useValidationSuite` is null for a
 * reader without the policy permission, while the files load, and when they
 * fail to load.
 */
export function ValidationProvider({ children }: { children: ReactNode }) {
  const sessionQuery = useSession();
  const session = sessionQuery?.data;
  const sessionKey = `${session?.session.id}:${session?.session.activeOrganizationId}`;
  const { data: canRead } = useHasPermissions({ guardrailsPolicy: ["read"] });
  const { data: canWrite } = useHasPermissions({
    guardrailsPolicy: ["update"],
  });
  const source = useOpenAppaPolicyTests(canRead === true);
  const collection = sessionQuery?.isPending ? undefined : source.data;
  return (
    <SuiteOwner
      sessionKey={sessionKey}
      collection={collection ?? EMPTY_COLLECTION}
      ready={collection !== undefined}
      canWrite={canWrite === true}
      loadError={source.error}
    >
      {children}
    </SuiteOwner>
  );
}

/** The validation suite; null until its files are there to show. */
export function useValidationSuite(): ValidationSuite | null {
  return useContext(ValidationContext);
}

/** The Policy page's entry for a validation file, as the URL carries it. */
export function validationEntry(path: string) {
  return `${VALIDATION_ENTRY_PREFIX}${path}`;
}

/** The validation file an entry names; null for a policy file's entry. */
export function validationPathOf(entry: string | null) {
  return entry?.startsWith(VALIDATION_ENTRY_PREFIX)
    ? entry.slice(VALIDATION_ENTRY_PREFIX.length)
    : null;
}

const VALIDATION_ENTRY_PREFIX = "validation:";

// Typed as the loaded collection is, with nothing in it.
const EMPTY_COLLECTION = {
  source: "local",
  files: [],
  version: "",
} as unknown as PolicyTestCollection;

function SuiteOwner({
  children,
  ...props
}: {
  children: ReactNode;
  collection: PolicyTestCollection;
  ready: boolean;
  canWrite: boolean;
  loadError: Error | null;
  sessionKey: string;
}) {
  const suite = useSuite(props);
  return (
    <ValidationContext.Provider value={props.ready ? suite : null}>
      {children}
    </ValidationContext.Provider>
  );
}

function useSuite({
  collection,
  ready,
  canWrite,
  loadError,
  sessionKey,
}: {
  collection: PolicyTestCollection;
  ready: boolean;
  canWrite: boolean;
  loadError: Error | null;
  sessionKey: string;
}) {
  const [baseline, setBaseline] = useState(collection);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A new session, and the files arriving, start the suite afresh. Done here
  // rather than by remounting, which would reset the editor around it too.
  const epoch = `${sessionKey}:${ready}`;
  const [seenEpoch, setSeenEpoch] = useState(epoch);
  if (seenEpoch !== epoch) {
    setSeenEpoch(epoch);
    setBaseline(collection);
    setSelected(new Set());
  }
  const history = useOpenAppaPolicyTestRuns(ready);
  const saveMutation = useSaveOpenAppaPolicyTests((next) => {
    if (next) {
      setBaseline(next);
      setSelected(new Set());
    }
  });
  const runMutation = useRunOpenAppaPolicyTests();
  const files = collection.files;
  const github = collection.source === "github";
  const busy = saveMutation.isPending || runMutation.isPending;
  const validPaths = hasValidPaths(files);
  const sourceChanged =
    collection.version !== baseline.version ||
    collection.source !== baseline.source ||
    collection.activeDirectory !== baseline.activeDirectory;
  const available = !collection.error && !loadError && !sourceChanged;
  const runnable =
    canWrite && !busy && files.length <= 32 && validPaths && available;
  const inspection = useValidationInspection(
    files,
    ready && files.length > 0 && available && validPaths && files.length <= 32,
  );
  function save(
    path: string,
    file: PolicyTestCollection["files"][number],
    expectedVersion: string,
    onSaved: (next: PolicyTestCollection) => void,
  ) {
    const submitted = baseline.files.map((current) =>
      current.path === path ? file : current,
    );
    if (
      github ||
      !canWrite ||
      busy ||
      !available ||
      expectedVersion !== baseline.version ||
      !hasValidPaths(submitted)
    )
      return;
    saveMutation.mutate(
      { files: submitted, expectedVersion },
      {
        onSuccess: (next) => {
          if (next) onSaved(next);
        },
      },
    );
  }
  /**
   * Runs every saved file and records the run. With a `progressToken`, the
   * server pushes per-file progress for it over the WebSocket.
   */
  function runAll(options?: {
    progressToken?: string;
    onSettled?: (run: PolicyTestRun | null, error: Error | null) => void;
  }) {
    if (!runnable || !files.length) return false;
    runMutation.mutate(
      {
        files,
        sourceVersion: collection.version,
        directory: collection.directory,
        progressToken: options?.progressToken,
      },
      {
        onSuccess: (run) => options?.onSettled?.(run ?? null, null),
        onError: (error) => options?.onSettled?.(null, error),
      },
    );
    return true;
  }
  /** Runs one saved file and records the result in run history. */
  function runFile(
    path: string,
    options?: {
      progressToken?: string;
      onSettled?: (run: PolicyTestRun | null, error: Error | null) => void;
    },
  ) {
    const file = files.find((item) => item.path === path);
    if (!runnable || !file) return false;
    runMutation.mutate(
      {
        files: [file],
        sourceVersion: collection.version,
        directory: collection.directory,
        partial: true,
        progressToken: options?.progressToken,
      },
      {
        onSuccess: (run) => options?.onSettled?.(run ?? null, null),
        onError: (error) => options?.onSettled?.(null, error),
      },
    );
    return true;
  }
  const runningPath =
    runMutation.isPending && runMutation.variables?.partial
      ? (runMutation.variables.files[0]?.path ?? null)
      : null;
  function deleteFiles(paths: string[], onDeleted?: () => void) {
    if (github || !canWrite || busy || !available) return;
    saveMutation.mutate(
      {
        files: baseline.files.filter((file) => !paths.includes(file.path)),
        expectedVersion: baseline.version,
      },
      {
        onSuccess: (next) => {
          if (next) onDeleted?.();
        },
      },
    );
  }
  return {
    sessionKey,
    files,
    collection,
    baseline,
    canWrite,
    github,
    busy,
    validPaths,
    sourceChanged,
    runnable,
    currentRun: history.data?.[0],
    selected,
    setSelected,
    history,
    runAll,
    runFile,
    runningPath,
    runningAll: runMutation.isPending && !runMutation.variables?.partial,
    save,
    deleteFiles,
    summaries: inspection.summaries,
    inspectionError: inspection.error,
    loadError,
  };
}

export function useValidationInspection(
  files: PolicyTestCollection["files"],
  enabled: boolean,
) {
  const inspectMutation = useInspectOpenAppaPolicyTests();
  const inspectRef = useRef(inspectMutation.mutate);
  inspectRef.current = inspectMutation.mutate;
  const [inspection, setInspection] = useState<{
    snapshot: string;
    data: PolicyTestInspection;
  } | null>(null);
  const snapshot = JSON.stringify(files);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => {
      inspectRef.current(
        { files: JSON.parse(snapshot) },
        {
          onSuccess: (data) => {
            if (data && latestSnapshot.current === snapshot)
              setInspection({ snapshot, data });
          },
        },
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [snapshot, enabled]);
  return {
    summaries:
      enabled && inspection?.snapshot === snapshot
        ? inspection.data.files
        : null,
    error: inspectMutation.error,
  };
}

function hasValidPaths(files: PolicyTestCollection["files"]) {
  return (
    files.every(
      (file) =>
        /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.appa$/.test(file.path) &&
        !file.path.split("/").some((part) => part === "." || part === ".."),
    ) && new Set(files.map((file) => file.path)).size === files.length
  );
}
