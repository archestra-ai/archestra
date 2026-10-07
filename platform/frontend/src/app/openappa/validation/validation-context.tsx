"use client";

import { useQueryClient } from "@tanstack/react-query";
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
import { useFieldArray, useForm } from "react-hook-form";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
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

type ValidationState = ReturnType<typeof useSuite>;
const ValidationContext = createContext<ValidationState | null>(null);

type RetainedDraft = {
  baseline: PolicyTestCollection;
  files: PolicyTestCollection["files"];
  ids: (string | undefined)[];
  selected: string[];
  listHref: string;
  reconciledFrom?: {
    version: string;
    files: PolicyTestCollection["files"];
    removed: number[];
    created?: PolicyTestCollection["files"][number];
  };
};

export function ValidationProvider({ children }: { children: ReactNode }) {
  const sessionQuery = useSession();
  const session = sessionQuery?.data;
  const draftKey =
    session?.session.id && session.session.activeOrganizationId
      ? [
          "openappa-validation-draft",
          session.session.id,
          session.session.activeOrganizationId,
        ]
      : null;
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
      key={JSON.stringify(draftKey)}
      draftKey={draftKey}
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

export function validationFileHref(path: string, draft?: string) {
  return `/openappa/validation/file?${new URLSearchParams({ path, ...(draft ? { draft } : {}) })}`;
}

function SuiteOwner({
  children,
  ...props
}: {
  children: ReactNode;
  collection: PolicyTestCollection;
  canWrite: boolean;
  loadError: Error | null;
  draftKey: string[] | null;
}) {
  const suite = useSuite(props);
  return (
    <ValidationContext.Provider value={suite}>
      {children}
      <UnsavedChangesDialog
        open={suite.guard.confirmOpen}
        onKeepEditing={suite.guard.keepEditing}
        onDiscard={suite.guard.discardChanges}
      />
    </ValidationContext.Provider>
  );
}

function useSuite({
  collection,
  canWrite,
  loadError,
  draftKey,
}: {
  collection: PolicyTestCollection;
  canWrite: boolean;
  loadError: Error | null;
  draftKey: string[] | null;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const [retained] = useState(() =>
    draftKey ? client.getQueryData<RetainedDraft>(draftKey) : undefined,
  );
  const form = useForm<{ files: PolicyTestCollection["files"] }>({
    defaultValues: { files: retained?.files ?? collection.files },
  });
  const {
    fields: formFields,
    append,
    remove,
  } = useFieldArray({
    control: form.control,
    name: "files",
  });
  const [restoredIds] = useState(
    () =>
      new Map(
        formFields.map((field, index) => [field.id, retained?.ids[index]]),
      ),
  );
  const fields = formFields.map((field) => ({
    ...field,
    id: restoredIds.get(field.id) ?? field.id,
  }));
  const files = form.watch("files");
  const [baseline, setBaseline] = useState(retained?.baseline ?? collection);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(retained?.selected),
  );
  const [listHref, setListHref] = useState(
    retained?.listHref ?? "/openappa/validation",
  );
  const [inspection, setInspection] = useState<{
    snapshot: string;
    data: PolicyTestInspection;
  } | null>(null);
  const history = useOpenAppaPolicyTestRuns(true);
  const pendingFileWrite = useRef<{
    version: string;
    dirty: boolean;
    files: PolicyTestCollection["files"];
    ids: string[];
    removed: number[];
    created?: PolicyTestCollection["files"][number];
  } | null>(null);
  const saveMutation = useSaveOpenAppaPolicyTests((next) => {
    const pending = pendingFileWrite.current;
    pendingFileWrite.current = null;
    if (!next || !pending) return;
    const remainingFiles = pending.files.filter(
      (_, index) => !pending.removed.includes(index),
    );
    const remainingIds: RetainedDraft["ids"] = pending.ids.filter(
      (_, index) => !pending.removed.includes(index),
    );
    if (pending.created) {
      remainingFiles.push(pending.created);
      remainingIds.push(undefined);
    }
    if (draftKey) {
      const cached = client.getQueryData<RetainedDraft>(draftKey);
      if (pending.dirty && !cached) return;
      if (
        cached &&
        (cached.baseline.version !== pending.version ||
          JSON.stringify(cached.files) !== JSON.stringify(pending.files))
      )
        return;
      client.setQueryDefaults(draftKey, { gcTime: Infinity });
      client.setQueryData<RetainedDraft>(draftKey, {
        baseline: next,
        files: remainingFiles,
        ids: remainingIds,
        selected: [],
        listHref: cached?.listHref ?? listHref,
        reconciledFrom: pending,
      });
    } else if (
      JSON.stringify(form.getValues("files")) === JSON.stringify(pending.files)
    ) {
      setBaseline(next);
      if (pending.removed.length) remove(pending.removed);
      if (pending.created) append(pending.created);
      setSelected(new Set());
    }
  });
  const runMutation = useRunOpenAppaPolicyTests();
  const inspectMutation = useInspectOpenAppaPolicyTests();
  const inspectRef = useRef(inspectMutation.mutate);
  inspectRef.current = inspectMutation.mutate;
  const snapshot = JSON.stringify(files);
  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;
  const dirty = snapshot !== JSON.stringify(baseline.files);
  useEffect(() => {
    if (!draftKey) return;
    if (!dirty) {
      client.removeQueries({ queryKey: draftKey, exact: true });
      return;
    }
    // Session-scoped memory only: browser Back can unmount this layout. This
    // separate, non-persisted key never changes the authoritative collection.
    client.setQueryDefaults(draftKey, { gcTime: Infinity });
    client.setQueryData<RetainedDraft>(draftKey, {
      baseline,
      files,
      ids: fields.map((field) => field.id),
      selected: [...selected],
      listHref,
    });
  }, [client, draftKey, dirty, baseline, files, fields, selected, listHref]);
  function clearDraft() {
    if (draftKey) client.removeQueries({ queryKey: draftKey, exact: true });
  }
  useEffect(() => {
    if (!draftKey) return;
    // A request can finish after Back has remounted a different owner. Adopt
    // its result only when that owner's text still matches the completed draft.
    return client.getQueryCache().subscribe((event) => {
      if (JSON.stringify(event.query.queryKey) !== JSON.stringify(draftKey))
        return;
      if (event.type === "updated") {
        const retained = event.query.state.data as RetainedDraft | undefined;
        const previous = retained?.reconciledFrom;
        const currentFiles = form.getValues("files");
        if (
          !retained ||
          !previous ||
          previous.version !== baseline.version ||
          JSON.stringify(previous.files) !== JSON.stringify(currentFiles)
        )
          return;
        setBaseline(retained.baseline);
        if (previous.removed.length) remove(previous.removed);
        if (previous.created) append(previous.created);
        setSelected(new Set());
      }
    });
  }, [client, draftKey, baseline.version, form, remove, append]);
  const github = collection.source === "github";
  const busy = saveMutation.isPending || runMutation.isPending;
  const validPaths = hasValidPaths(files);
  const sourceChanged =
    collection.version !== baseline.version ||
    collection.source !== baseline.source ||
    collection.activeDirectory !== baseline.activeDirectory;
  const runnable =
    canWrite &&
    !busy &&
    collection.files.length <= 32 &&
    hasValidPaths(collection.files) &&
    !collection.error &&
    !loadError &&
    !sourceChanged;
  const currentRun = history.data?.[0];
  useEffect(() => {
    if (
      collection.error ||
      loadError ||
      sourceChanged ||
      !validPaths ||
      files.length > 32
    )
      return;
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
  }, [
    snapshot,
    collection.error,
    loadError,
    sourceChanged,
    validPaths,
    files.length,
  ]);

  const pendingAction = useRef<(() => void) | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty: dirty,
    onOpenChange: (open) => {
      if (open) return;
      const action = pendingAction.current;
      pendingAction.current = null;
      action?.();
    },
  });
  function requestDiscard(action: () => void) {
    if (!dirty) {
      action();
      return;
    }
    pendingAction.current = action;
    guard.requestClose();
  }
  useBeforeUnloadWhileDirty(dirty);
  useGuardedInAppNavigation({
    isDirty: dirty,
    onRequestNavigate: (href) => {
      const path = href.split(/[?#]/)[0];
      if (
        path === "/openappa/validation" ||
        path.startsWith("/openappa/validation/")
      )
        router.push(href);
      else
        requestDiscard(() => {
          clearDraft();
          form.reset({ files: baseline.files });
          router.push(href);
        });
    },
  });
  function reset(next: PolicyTestCollection) {
    clearDraft();
    setBaseline(next);
    form.reset({ files: next.files });
    setSelected(new Set());
  }
  function save(index: number, onSaved?: () => void) {
    if (
      github ||
      !canWrite ||
      busy ||
      sourceChanged ||
      loadError ||
      collection.error ||
      !validPaths ||
      !files[index]
    )
      return;
    const submitted = baseline.files.map((file, position) =>
      position === index ? files[index] : file,
    );
    pendingFileWrite.current = {
      version: baseline.version,
      dirty,
      files: structuredClone(files),
      ids: fields.map((field) => field.id),
      removed: [],
    };
    saveMutation.mutate(
      { files: submitted, expectedVersion: baseline.version },
      {
        onSuccess: (next) => {
          if (next) {
            onSaved?.();
          }
        },
      },
    );
  }
  function runAll() {
    if (!runnable || !collection.files.length) return;
    runMutation.mutate({
      files: collection.files,
      sourceVersion: collection.version,
      directory: collection.directory,
    });
  }
  function add() {
    if (github || !canWrite || busy || sourceChanged || files.length >= 32)
      return;
    requestDiscard(() => {
      reset(baseline);
      router.push("/openappa/validation/new");
    });
  }
  function createFile(
    file: PolicyTestCollection["files"][number],
    onCreated: () => void,
    onError: (error: Error) => void,
  ) {
    if (
      github ||
      !canWrite ||
      busy ||
      dirty ||
      sourceChanged ||
      loadError ||
      collection.error ||
      baseline.files.length >= 32
    )
      return;
    pendingFileWrite.current = {
      version: baseline.version,
      dirty,
      files: structuredClone(files),
      ids: fields.map((field) => field.id),
      removed: [],
      created: file,
    };
    saveMutation.mutate(
      { files: [...baseline.files, file], expectedVersion: baseline.version },
      {
        onSuccess: (next) => {
          if (!next) return;
          onCreated();
        },
        onError,
      },
    );
  }
  function deleteFiles(ids: string[], onDeleted?: () => void) {
    if (
      github ||
      !canWrite ||
      busy ||
      sourceChanged ||
      loadError ||
      collection.error
    )
      return;
    const removed = new Set(ids);
    const positions = fields.flatMap((field, index) =>
      removed.has(field.id) ? [index] : [],
    );
    if (!positions.length) return;
    pendingFileWrite.current = {
      version: baseline.version,
      dirty,
      files: structuredClone(files),
      ids: fields.map((field) => field.id),
      removed: positions,
    };
    saveMutation.mutate(
      {
        files: baseline.files.filter((_, index) => !positions.includes(index)),
        expectedVersion: baseline.version,
      },
      {
        onSuccess: (next) => {
          if (!next) return;
          onDeleted?.();
        },
      },
    );
  }
  const summaries =
    !collection.error &&
    !loadError &&
    !sourceChanged &&
    inspection?.snapshot === snapshot
      ? inspection.data.files
      : null;
  return {
    form,
    fields,
    files,
    collection,
    baseline,
    canWrite,
    github,
    busy,
    dirty,
    validPaths,
    sourceChanged,
    runnable,
    currentRun,
    selected,
    setSelected,
    history,
    runAll,
    save,
    add,
    createFile,
    deleteFiles,
    guard,
    listHref,
    setListHref,
    summaries,
    inspectionError: inspectMutation.error,
    loadError,
  };
}

function hasValidPaths(files: PolicyTestCollection["files"]) {
  return (
    files.every(
      (file) => file.path.endsWith(".appa") && file.path.trim().length > 5,
    ) && new Set(files.map((file) => file.path)).size === files.length
  );
}
