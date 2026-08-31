"use client";

import { ArrowLeft, ArrowRight, Info } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import {
  backToRecordLabel,
  notYoursToChange,
} from "@/lib/design/resource-lexicon";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import { useSkill, useUpdateSkill } from "@/lib/skills/skill.query";
import { useSkillAccess } from "@/lib/skills/use-skill-access";
import { cn } from "@/lib/utils";
import {
  GithubSnapshotNotice,
  GithubSyncPanel,
  type SkillDetail,
} from "../../_parts/github-sync-panel";
import { SkillAccessFields } from "../../_parts/skill-access-fields";
import {
  SKILL_WIZARD_EDITOR_CLASS,
  SkillContentEditor,
} from "../../_parts/skill-content-editor";
import {
  buildSkillSaveBody,
  isSkillDraftDirty,
  isSyncedGithubSkill,
  type SkillDraft,
  skillDraftFromSkill,
} from "../../_parts/skill-draft";
import {
  resolveSkillEditStep,
  SKILL_EDIT_STEPS,
  type SkillEditStepId,
  skillDetailHref,
  skillGithubSourceRepo,
} from "../../_parts/skill-page-config";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../../_parts/skill-page-shell";

const STEP_DESCRIPTIONS: Record<SkillEditStepId, string> = {
  content:
    "Write the SKILL.md manifest and add any resource files the skill needs.",
  access: "Choose who can use the skill and where.",
};

/**
 * `/skills/[id]/edit` — the create wizard's Content and Access steps on an
 * existing skill, URL-driven by `?step=`. One draft spans both steps, so
 * moving between them keeps what was typed; Save on either step writes it
 * and returns to the skill's page (one field changed is one save, not a walk
 * through the remaining steps), Save & Continue writes it and moves on.
 */
export function SkillEditPage({ id }: { id: string }) {
  const { data: skill, isPending } = useSkill(id);
  if (isPending) return <SkillPageLoading />;
  if (!skill) return <SkillNotFound />;
  return <SkillEditWizard skill={skill} />;
}

function SkillEditWizard({ skill }: { skill: SkillDetail }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `skill:update` alone is not enough: the backend also asks whose skill this
  // is, so a holder of the permission editing somebody else's skill used to
  // fill the whole wizard and collect a 403 from Save.
  const {
    canEdit,
    canUpdate,
    isPending: isAccessPending,
  } = useSkillAccess(skill);
  // Undecided is not refused. Reading the permissions as "no" while they load
  // would flash the read-only notice at the author of the skill.
  const isReadOnly = !isAccessPending && !canEdit;
  const updateSkill = useUpdateSkill();

  const step = resolveSkillEditStep(searchParams.get("step"));
  const stepIndex = SKILL_EDIT_STEPS.findIndex((s) => s.id === step);
  const prevStep = SKILL_EDIT_STEPS[stepIndex - 1];
  const nextStep = SKILL_EDIT_STEPS[stepIndex + 1];
  const detailHref = skillDetailHref(skill.id);
  const goToStep = (target: SkillEditStepId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("step", target);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

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
  // Which save is in flight: Save finishes on the skill's page, Save &
  // Continue moves to the next step.
  const [savingWith, setSavingWith] = useState<"finish" | "continue" | null>(
    null,
  );
  const isSaving = savingWith !== null;

  const handleSave = async (intent: "finish" | "continue") => {
    // The draft can move while the request is in flight, so what was sent is
    // what the new base records — anything typed meanwhile stays unsaved
    // rather than being counted as written.
    const submitted = draft;
    setSavingWith(intent);
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both leave the draft intact so the author can
    // retry without retyping.
    const saved = await updateSkill
      .mutateAsync({
        id: skill.id,
        body: buildSkillSaveBody(submitted, skill, base.version),
      })
      .catch(() => null);
    setSavingWith(null);
    if (!saved) return;
    setBase({ draft: submitted, version: saved.latestVersion });
    if (intent === "continue" && nextStep) goToStep(nextStep.id);
    else router.push(detailHref);
  };

  // Unsaved edits guard every way out of the wizard that is not a save: the
  // back link and Cancel. Steps share the draft, so moving between them
  // loses nothing and asks nothing.
  useBeforeUnloadWhileDirty(isDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const guard = useUnsavedChangesGuard({
    isDirty,
    onOpenChange: (open) => {
      if (open) return;
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) router.push(href);
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );

  return (
    <PageLayout
      title={`Edit ${skill.name}`}
      documentTitle={`Edit ${skill.name}`}
      description={STEP_DESCRIPTIONS[step]}
      backLink={
        <SkillBackLink
          href={detailHref}
          label={backToRecordLabel("skill")}
          onClick={(event) => {
            if (!isDirty) return;
            event.preventDefault();
            requestNavigate(detailHref);
          }}
        />
      }
      actionButton={
        <WizardStepper
          compact
          steps={SKILL_EDIT_STEPS}
          activeStep={step}
          onStepClick={(target) => {
            if (target !== step) goToStep(target);
          }}
        />
      }
      maxWidth="wizard"
    >
      <div className="space-y-6">
        {isReadOnly && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              {canUpdate
                ? `${notYoursToChange({ resource: "skill", scope: skill.scope })}.`
                : "You can view this skill's configuration but not change it."}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-4">
          <div className="flex min-h-0 flex-col gap-4 rounded-lg border p-6">
            {step === "content" &&
              (isSynced ? (
                <GithubSyncPanel skill={skill} sourceRepo={githubSourceRepo} />
              ) : (
                isGithubSkill && (
                  <GithubSnapshotNotice repo={githubSourceRepo} />
                )
              ))}
            {/* Kept mounted across steps: the open file, collapsed folders
                and the trash bin of soft-deleted files are the editor's own
                state, and a trip to Access is not a decision to drop them. */}
            <div
              className={cn(
                "flex min-h-0 flex-col",
                step !== "content" && "hidden",
              )}
            >
              <SkillContentEditor
                manifest={draft.manifest}
                files={draft.files}
                onManifestChange={(manifest) => patchDraft({ manifest })}
                onFilesChange={(update) =>
                  setDraft((prev) => ({
                    ...prev,
                    files: update(prev.files),
                  }))
                }
                readOnly={isSynced || isReadOnly}
                className={SKILL_WIZARD_EDITOR_CLASS}
              />
            </div>
            {step === "access" && (
              <fieldset disabled={isReadOnly} className="contents">
                <SkillAccessFields draft={draft} onChange={patchDraft} />
              </fieldset>
            )}
          </div>
          <WizardFooter>
            <div className="flex items-center gap-2">
              {prevStep ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSaving}
                  onClick={() => goToStep(prevStep.id)}
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>{prevStep.title}</span>
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isSaving}
                  onClick={() => requestNavigate(detailHref)}
                >
                  Cancel
                </Button>
              )}
              {isDirty && !isSaving && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={discardChanges}
                >
                  Discard changes
                </Button>
              )}
            </div>
            {/* Save is on every step: it writes the draft and returns to the
                skill's page — once clean it just returns. On the last step it
                is the one action; before it, Save & Continue stays primary. */}
            <div className="flex items-center gap-2">
              {isDirty || isSaving ? (
                <PermissionButton
                  permissions={{ skill: ["update"] }}
                  variant={nextStep ? "outline" : "default"}
                  disabled={!contentComplete || isSaving}
                  onClick={() => handleSave("finish")}
                >
                  {savingWith === "finish" ? "Saving..." : "Save"}
                </PermissionButton>
              ) : (
                <Button
                  type="button"
                  variant={nextStep ? "outline" : "default"}
                  onClick={() => router.push(detailHref)}
                >
                  Save
                </Button>
              )}
              {nextStep &&
                (isDirty || isSaving ? (
                  <PermissionButton
                    permissions={{ skill: ["update"] }}
                    disabled={!contentComplete || isSaving}
                    onClick={() => handleSave("continue")}
                  >
                    <span>
                      {savingWith === "continue"
                        ? "Saving..."
                        : "Save & Continue"}
                    </span>
                    <ArrowRight className="h-4 w-4" />
                  </PermissionButton>
                ) : (
                  <Button
                    type="button"
                    disabled={!contentComplete}
                    onClick={() => goToStep(nextStep.id)}
                  >
                    <span>{nextStep.title}</span>
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ))}
            </div>
          </WizardFooter>
        </div>

        <UnsavedChangesDialog
          open={guard.confirmOpen}
          onKeepEditing={guard.keepEditing}
          onDiscard={guard.discardChanges}
        />
      </div>
    </PageLayout>
  );
}
