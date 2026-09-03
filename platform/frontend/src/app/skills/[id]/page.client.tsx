"use client";

import { E2eTestId } from "@archestra/shared";
import { History, Info, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentBadge } from "@/components/agent-badge";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CreatedByCell } from "@/components/created-by-cell";
import { PageLayout } from "@/components/page-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import {
  backToListLabel,
  notYoursToChange,
} from "@/lib/design/resource-lexicon";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import { useSkill, useUpdateSkill } from "@/lib/skills/skill.query";
import { useSkillAccess } from "@/lib/skills/use-skill-access";
import { ChatWithSkillButton } from "../_parts/chat-with-skill-button";
import { DeleteSkillDialog } from "../_parts/delete-skill-dialog";
import {
  GithubSnapshotNotice,
  GithubSyncPanel,
  type SkillDetail,
} from "../_parts/github-sync-panel";
import {
  getSkillActionModel,
  skillAction,
} from "../_parts/skill-actions-model";
import {
  buildSkillSaveBody,
  isSkillDraftDirty,
  isSyncedGithubSkill,
  type SkillDraft,
  skillDraftFromSkill,
} from "../_parts/skill-draft";
import { SkillForm } from "../_parts/skill-form";
import {
  resolveSkillDetailSection,
  SKILL_DESCRIPTION_FALLBACK,
  SKILL_DETAIL_SECTIONS,
  SKILL_SECTION_LABELS,
  type SkillDetailSection,
  skillDetailHref,
  skillGithubSourceRepo,
} from "../_parts/skill-page-config";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../_parts/skill-page-shell";
import { SkillUsagePanel } from "../_parts/skill-usage-panel";
import { SkillVersionHistoryDialog } from "../_parts/skill-version-history-dialog";

const SECTION_DESCRIPTIONS: Record<SkillDetailSection, string> = {
  // Settings is the page's default and shows the skill's own description
  // instead; this stands in only when the skill has none.
  settings: SKILL_DESCRIPTION_FALLBACK,
  usage: "Who has run this skill, and when.",
};

/**
 * `/skills/[id]` — one skill's page. Its content and access are edited here,
 * in sections, rather than behind an Edit button that opened a wizard on a
 * second route: the skill's settings are the page, the way an agent's are.
 */
export function SkillDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { data: skill, isPending } = useSkill(id);

  // Hold the last skill this mount saw. Deleting it in another tab (or any
  // background refetch that answers 404) turns `data` into null, and dropping
  // the page on that would throw away whatever has been typed into the
  // editor since. The page stays up on the held copy and says it is gone.
  const heldSkillRef = useRef<SkillDetail | null>(null);
  if (skill) heldSkillRef.current = skill;
  const heldSkill = skill ?? heldSkillRef.current;
  // A successful null after we had a skill — not a failed request, which
  // leaves the previous data in place.
  const isGone = !skill && !!heldSkillRef.current;

  // Deleting invalidates the skills queries, and the refetch resolves to null
  // before the navigation back to the list has finished — without the flag the
  // page would flash "Skill not found" for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);

  if (heldSkill && !isLeavingAfterDelete) {
    return (
      <SkillDetailView
        skill={heldSkill}
        isGone={isGone}
        onDeleted={() => {
          setIsLeavingAfterDelete(true);
          router.push("/skills");
        }}
      />
    );
  }

  if (isPending || isLeavingAfterDelete) return <SkillPageLoading />;
  return <SkillNotFound />;
}

function SkillDetailView({
  skill,
  isGone,
  onDeleted,
}: {
  skill: SkillDetail;
  /** The skill has since been deleted; this is the last copy we hold. */
  isGone: boolean;
  /** Owned by the page so it can suppress its not-found state on the way out. */
  onDeleted: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `skill:update` alone is not enough: the backend also asks whose skill this
  // is, so a holder of the permission editing somebody else's skill used to
  // fill the whole form and collect a 403 from Save.
  const {
    canModify,
    canUpdate,
    canEdit,
    canDelete,
    isPending: isAccessPending,
  } = useSkillAccess(skill);
  // Undecided is not refused. Reading the permissions as "no" while they load
  // would flash the read-only notice at the author of the skill.
  const isReadOnly = !isAccessPending && !canEdit;
  const updateSkill = useUpdateSkill();

  const actionModel = getSkillActionModel(skill.id);
  const historyAction = skillAction(actionModel, "history");
  const deleteAction = skillAction(actionModel, "delete");

  // The sentence for a reader the scope check refused. A reader who holds no
  // `skill:update` at all is refused by RBAC instead, and `PermissionButton`
  // states that constraint, which is the one actually refusing them.
  const notYours = notYoursToChange({
    resource: "skill",
    scope: skill.scope,
  });
  // `canDelete` is the delete permission AND the scope check, so which of the
  // two refused decides which sentence is the true one.
  const deleteReason = canDelete
    ? undefined
    : canModify
      ? formatPermissionConstraint({ skill: ["delete"] })
      : notYours;

  // A `?section=` this page has none of (a typo, or a section that has since
  // been removed) silently resolves to the first. `?tab=usage` is the shape
  // the Usage view shipped with and is still pasted around, so it is read as
  // well; the URL is corrected to whichever section actually rendered, so a
  // reload, a copied link or the back button does not keep asking for
  // something else.
  const sectionParam = searchParams.get("section") ?? searchParams.get("tab");
  const section = resolveSkillDetailSection(sectionParam);
  useEffect(() => {
    if (searchParams.get("section") === section) return;
    router.replace(skillDetailHref(skill.id, section), { scroll: false });
  }, [searchParams, section, skill.id, router]);

  // The draft is seeded from the loaded skill, and `base` records what it was
  // seeded from: the content to diff against, and the version the edit is
  // anchored to. They are kept in step with the *draft*, not with the query —
  // this page is open for as long as someone is writing, and reads land under
  // it unbidden (a window-focus refetch, a sync pull, another tab's save), so
  // adopting every read would discard unsaved work and silently re-anchor the
  // save to a head the author never saw.
  const seed = useMemo(() => skillDraftFromSkill(skill), [skill]);
  const [draft, setDraft] = useState<SkillDraft>(seed);
  const [base, setBase] = useState<{ draft: SkillDraft; version: number }>({
    draft: seed,
    version: skill.latestVersion,
  });
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const isDirty = isSkillDraftDirty(draft, base.draft);

  // Adopt a read only when there is nothing to lose and it is not older than
  // what this page has already written. Both guards earn their keep:
  // - while the draft is dirty the stale anchor is kept deliberately, so a
  //   save composed against an overtaken head is rejected rather than burying
  //   whoever moved it;
  // - a save invalidates the skill and the refetch lands a moment later, so
  //   the cached skill is briefly the pre-save one — adopting it would walk
  //   the anchor backwards and make the next save 409 against a head this
  //   page itself set.
  useEffect(() => {
    if (isDirty || skill.latestVersion < base.version) return;
    setDraft(seed);
    setBase({ draft: seed, version: skill.latestVersion });
  }, [isDirty, seed, skill.latestVersion, base.version]);

  const patchDraft = (patch: Partial<SkillDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  // Discard is also the way out of a version conflict: the failed save has
  // already invalidated the skill, so this picks up the latest content.
  const discardChanges = () => {
    setDraft(seed);
    setBase({ draft: seed, version: skill.latestVersion });
  };

  const isSynced = isSyncedGithubSkill(skill);
  const isGithubSkill = skill.sourceType === "github";
  const githubSourceRepo = skillGithubSourceRepo(skill);

  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );
  const contentComplete = parsed.hasName && parsed.hasDescription;
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    // The draft can move while the request is in flight, so what was sent is
    // what the new base records — anything typed meanwhile stays unsaved
    // rather than being counted as written.
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    const submitted = { ...draft, labels: finalLabels };
    setIsSaving(true);
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both leave the draft intact so the author can
    // retry without retyping.
    const saved = await updateSkill
      .mutateAsync({
        id: skill.id,
        body: buildSkillSaveBody(submitted, skill, base.version),
      })
      .catch(() => null);
    setIsSaving(false);
    if (!saved) return;
    setBase({ draft: submitted, version: saved.latestVersion });
  };

  // Unsaved edits guard every way off the page that is not a save: another
  // section, the back link, the sidebar. The pending destination is parked
  // here and taken once the guard lets go.
  useBeforeUnloadWhileDirty(isDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      // A section change is the same page with another query, so it replaces
      // rather than stacking a history entry per section.
      if (href) {
        if (href.startsWith(pathname)) router.replace(href, { scroll: false });
        else router.push(href);
      }
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  // Every in-app link, not only the ones this page renders: the editor is the
  // page now, so the sidebar and anything else on screen would otherwise
  // discard unsaved edits without asking.
  useGuardedInAppNavigation({ isDirty, onRequestNavigate: requestNavigate });

  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const deleteReasonId = useId();

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{skill.name}</span>
          <AgentBadge type={skill.scope} className="font-normal" />
          <Badge variant="outline" className="font-normal">
            v{skill.latestVersion}
          </Badge>
          {isGithubSkill && (
            <Badge variant="secondary" className="font-normal">
              {isSynced ? "Synced from GitHub" : "Imported from GitHub"}
            </Badge>
          )}
          {skill.sourceType === "built_in" && (
            <Badge variant="secondary" className="font-normal">
              Built-in
            </Badge>
          )}
        </div>
      }
      documentTitle={skill.name}
      description={
        section === "settings"
          ? skill.description || SECTION_DESCRIPTIONS.settings
          : SECTION_DESCRIPTIONS[section]
      }
      backLink={
        <SkillBackLink href="/skills" label={backToListLabel("skill")} />
      }
      maxWidth="wizard"
      minWidth="phone"
      tabs={SKILL_DETAIL_SECTIONS.map((entry) => ({
        label: SKILL_SECTION_LABELS[entry],
        href: skillDetailHref(skill.id, entry),
        testId: `${E2eTestId.SkillDetailSection}-${entry}`,
        selected: entry === section,
      }))}
      // Every section is a tab, so the mobile row keeps them all rather than
      // folding the last one into an overflow popover.
      mobileVisibleCount={SKILL_DETAIL_SECTIONS.length}
      actionButton={
        // Editing is the page itself now, so the header carries only what the
        // page cannot: chatting with the skill, and the actions that act on it
        // as a whole.
        <div className="flex shrink-0 items-center gap-2">
          {/* Who to ask about this skill. The facts row this used to sit in is
              gone — the page is the skill's own settings, top to bottom — so
              the creator sits in the header beside the actions. Dropped on
              phones, where the header has no room to spare. A skill with no
              creator recorded shows nothing rather than an empty label, which
              would read as a name that failed to load. */}
          {skill.createdBy && (
            <p className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
              <span className="shrink-0">Created by</span>
              <CreatedByCell createdBy={skill.createdBy} />
            </p>
          )}
          <ChatWithSkillButton skillId={skill.id} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">More actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History className="h-4 w-4" />
                {historyAction.label}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* `aria-disabled` rather than Radix's `disabled`, so the item
                  keeps its place in the menu's roving focus and the reason
                  below stays reachable by keyboard. */}
              <DropdownMenuItem
                variant="destructive"
                aria-disabled={!canDelete || undefined}
                aria-describedby={deleteReason ? deleteReasonId : undefined}
                className={
                  canDelete ? undefined : "cursor-not-allowed opacity-50"
                }
                onSelect={(event) => {
                  if (!canDelete) event.preventDefault();
                }}
                onClick={(event) => {
                  if (!canDelete) {
                    event.preventDefault();
                    return;
                  }
                  setDeleteRequested(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                {deleteAction.label}
                {/* The reason as text, not only as a tooltip: a menu item
                    reached by keyboard never opens one. `aria-hidden` keeps it
                    out of the accessible name, where it would duplicate the
                    description a screen reader already reads from
                    `aria-describedby`. */}
                {deleteReason && (
                  <span
                    id={deleteReasonId}
                    aria-hidden="true"
                    className="sr-only"
                  >
                    {deleteReason}
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {section === "usage" ? (
        <SkillUsagePanel skillRef={{ kind: "standalone", skillId: skill.id }} />
      ) : (
        <div className="flex flex-col gap-4">
          {isGone ? (
            <Alert variant="destructive">
              <AlertDescription>
                This skill is no longer available — it was deleted while you
                were editing it. Your unsaved changes cannot be saved; copy
                anything you need before leaving.
              </AlertDescription>
            </Alert>
          ) : (
            isReadOnly && (
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  You can view this skill&apos;s configuration but not change
                  it. {canUpdate ? `${notYours}.` : ""}
                </AlertDescription>
              </Alert>
            )
          )}

          <SkillForm
            draft={draft}
            onChange={patchDraft}
            onFilesChange={(update) =>
              setDraft((prev) => ({ ...prev, files: update(prev.files) }))
            }
            labelsRef={labelsRef}
            readOnly={isReadOnly}
            // A synced skill's manifest and files belong to the repository;
            // who may use it is still this organization's to decide.
            contentReadOnly={isSynced}
            contentNotice={
              isSynced ? (
                <GithubSyncPanel skill={skill} sourceRepo={githubSourceRepo} />
              ) : isGithubSkill ? (
                <GithubSnapshotNotice repo={githubSourceRepo} />
              ) : null
            }
          />

          {/* A reader who cannot change the skill has no save row at all — the
              alert above already says why. No rule above it either: the panel
              is already ruled off, and a second line right under it read as a
              stray divider. */}
          {!isReadOnly && (
            <WizardFooter className="border-t-0 sm:justify-end">
              <div className="flex items-center gap-2">
                {isDirty && !isSaving && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={discardChanges}
                  >
                    Discard changes
                  </Button>
                )}
                <PermissionButton
                  permissions={{ skill: ["update"] }}
                  disabled={!isDirty || !contentComplete || isGone || isSaving}
                  onClick={handleSave}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Save changes</span>
                  )}
                </PermissionButton>
              </div>
            </WizardFooter>
          )}
        </div>
      )}

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />
      {historyOpen && (
        <SkillVersionHistoryDialog
          skillId={skill.id}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
        />
      )}
      {deleteRequested && (
        <DeleteSkillDialog
          skill={skill}
          open={deleteRequested}
          onOpenChange={setDeleteRequested}
          onDeleted={onDeleted}
        />
      )}
    </PageLayout>
  );
}
