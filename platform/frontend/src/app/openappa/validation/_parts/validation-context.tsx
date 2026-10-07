"use client";

import { Info } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  type PolicyTestCollection,
  type PolicyTestInspection,
  useInspectOpenAppaPolicyTests,
  useOpenAppaPolicyTestRuns,
  useOpenAppaPolicyTests,
  useRunOpenAppaPolicyTests,
  useSaveOpenAppaPolicyTests,
} from "@/lib/openappa-policy-tests.query";

import { reconcileValidationDraft } from "./validation-draft";

type ValidationState = ReturnType<typeof useSuite>;
const ValidationContext = createContext<ValidationState | null>(null);

export function ValidationProvider({ children }: { children: ReactNode }) {
  const sessionQuery = useSession();
  const session = sessionQuery?.data;
  const sessionKey = `${session?.session.id}:${session?.session.activeOrganizationId}`;
  const { data: canRead } = useHasPermissions({ openappaPolicy: ["read"] });
  const { data: canWrite } = useHasPermissions({ openappaPolicy: ["update"] });
  const source = useOpenAppaPolicyTests(canRead === true);
  if (canRead === false)
    return (
      <InlineNotice>
        <Info />
        <span className="font-medium">Access required</span>
        <InlineNoticeText>
          You need policy read permission to view validation.
        </InlineNoticeText>
      </InlineNotice>
    );
  if (source.isLoading || canRead === undefined || sessionQuery?.isPending)
    return <Skeleton className="h-80 w-full" />;
  if (!source.data)
    return (
      <QueryLoadError
        title="Could not load policy validation"
        description={source.error?.message}
        onRetry={() => source.refetch()}
      />
    );
  return (
    <SuiteOwner
      key={sessionKey}
      sessionKey={sessionKey}
      collection={source.data}
      canWrite={canWrite === true}
      loadError={source.error}
    >
      {children}
    </SuiteOwner>
  );
}

export function useValidation() {
  const value = useContext(ValidationContext);
  if (!value) throw new Error("Validation page requires its suite provider");
  return value;
}

export function validationFileHref(path: string) {
  return `/openappa/validation/file?${new URLSearchParams({ path })}`;
}

function SuiteOwner({
  children,
  ...props
}: {
  children: ReactNode;
  collection: PolicyTestCollection;
  canWrite: boolean;
  loadError: Error | null;
  sessionKey: string;
}) {
  const suite = useSuite(props);
  return (
    <ValidationContext.Provider value={suite}>
      {children}
    </ValidationContext.Provider>
  );
}

function useSuite({
  collection,
  canWrite,
  loadError,
  sessionKey,
}: {
  collection: PolicyTestCollection;
  canWrite: boolean;
  loadError: Error | null;
  sessionKey: string;
}) {
  const router = useRouter();
  const [baseline, setBaseline] = useState(collection);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listHref, setListHref] = useState("/openappa/validation");
  const history = useOpenAppaPolicyTestRuns(true);
  const saveMutation = useSaveOpenAppaPolicyTests((next, submitted) => {
    if (next) {
      reconcileValidationDraft(sessionKey, next, submitted.expectedVersion);
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
    available && validPaths && files.length <= 32,
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
  function runAll() {
    if (!runnable || !files.length) return;
    runMutation.mutate({
      files,
      sourceVersion: collection.version,
      directory: collection.directory,
    });
  }
  function add() {
    if (github || !canWrite || busy || !available || files.length >= 32) return;
    router.push("/openappa/validation/new");
  }
  function createFile(
    file: PolicyTestCollection["files"][number],
    expectedVersion: string,
    onCreated: () => void,
    onError: (error: Error) => void,
  ) {
    if (
      github ||
      !canWrite ||
      busy ||
      !available ||
      expectedVersion !== baseline.version ||
      baseline.files.length >= 32
    )
      return;
    saveMutation.mutate(
      { files: [...baseline.files, file], expectedVersion },
      {
        onSuccess: (next) => {
          if (next) onCreated();
        },
        onError,
      },
    );
  }
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
    save,
    add,
    createFile,
    deleteFiles,
    listHref,
    setListHref,
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
