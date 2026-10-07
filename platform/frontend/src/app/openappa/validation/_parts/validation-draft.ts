import type { PolicyTestCollection } from "@/lib/openappa-policy-tests.query";

type EditorDraft = {
  scope: string;
  route: string;
  baseline: PolicyTestCollection;
  values: PolicyTestCollection["files"][number];
};

export function getValidationDraft(scope: string, route: string) {
  if (activeDraft?.scope !== scope) activeDraft = undefined;
  return activeDraft?.route === route ? activeDraft : undefined;
}

export function retainValidationDraft(draft: EditorDraft) {
  activeDraft = { ...draft, values: { ...draft.values } };
}

export function clearValidationDraft(scope: string, route: string) {
  if (activeDraft?.scope === scope && activeDraft.route === route)
    activeDraft = undefined;
}

export function reconcileValidationDraft(
  scope: string,
  next: PolicyTestCollection,
  expectedVersion: string,
) {
  const draft = activeDraft;
  if (
    !draft ||
    draft.scope !== scope ||
    draft.baseline.version !== expectedVersion
  )
    return;
  const original = draft.baseline.files.find(
    (file) => `file:${file.path}` === draft.route,
  );
  const persisted = next.files.find((file) => file.path === draft.values.path);
  if (
    (original &&
      !next.files.some((file) => file.path === original.path) &&
      next.files.every((file) =>
        draft.baseline.files.some((previous) => previous.path === file.path),
      )) ||
    (persisted && JSON.stringify(persisted) === JSON.stringify(draft.values))
  )
    activeDraft = undefined;
}

let activeDraft: EditorDraft | undefined;
