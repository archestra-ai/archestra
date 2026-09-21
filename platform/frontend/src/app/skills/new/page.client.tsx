"use client";

import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  FileText,
  Github,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import type { ProfileLabelsRef } from "@/components/agent-labels";
import { CatalogSourceCard } from "@/components/catalog-source-card";
import { FilterBar } from "@/components/filter-bar";
import { PageWizard } from "@/components/page-wizard";
import { SearchInput } from "@/components/search-input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { Separator } from "@/components/ui/separator";
import {
  UnsavedChangesDialog,
  useBeforeUnloadWhileDirty,
  useGuardedInAppNavigation,
  useUnsavedChangesGuard,
} from "@/components/unsaved-changes-guard";
import { WizardFooter } from "@/components/wizard-footer";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useOrganization } from "@/lib/organization.query";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import {
  type SkillCatalogResult,
  useCreateSkill,
  useSearchSkillCatalog,
} from "@/lib/skills/skill.query";
import {
  ImportSkillsDialog,
  type IndexedSkillSelection,
} from "../_parts/import-skills-dialog";
import { POPULAR_REPOS } from "../_parts/popular-repos";
import {
  blankSkillDraft,
  buildSkillSaveBody,
  isSkillDraftDirty,
  type SkillDraft,
} from "../_parts/skill-draft";
import { SkillForm } from "../_parts/skill-form";
import { SkillBackLink } from "../_parts/skill-page-shell";

type CreateStep = "source" | "configure";
type SkillImportState = {
  repoUrl: string;
  autoDiscover: boolean;
  initialSkill?: IndexedSkillSelection;
};

const CONFIGURE_STEPS = [{ id: "configure", title: "Configure" }] as const;

const STEP_DESCRIPTIONS: Record<CreateStep, string> = {
  source: "Import from a GitHub repo or start from a blank template.",
  // The whole skill is on one page, so the sentence names the whole of it —
  // and the skill's own page says the same thing over the same form.
  configure:
    "Write the SKILL.md manifest, add any resource files, and choose who can use it.",
};

export default function NewSkillPage() {
  return (
    <div className="h-full w-full">
      <ErrorBoundary>
        <NewSkillWizard />
      </ErrorBoundary>
    </div>
  );
}

function NewSkillWizard() {
  const router = useRouter();
  const { data: canCreate } = useHasPermissions({ skill: ["create"] });
  const { data: canReadSkills, isPending: isReadPermissionPending } =
    useHasPermissions({ skill: ["read"] });
  const [importState, setImportState] = useState<SkillImportState | null>(null);
  const [search, setSearch] = useState("");
  const { data: organization, isPending: isOrganizationPending } =
    useOrganization();

  // Fail closed: only offer the public skill catalog (popular repos + skill
  // index search) and the GitHub-import entry points once the org read confirms
  // it is enabled. A missing/stale read keeps them hidden rather than exposing
  // them against an admin's intent. When disabled, the wizard skips the source
  // step and opens on the blank template.
  const catalogEnabled = organization?.onlineSkillCatalogEnabled === true;
  const catalogDisabled = !isOrganizationPending && !catalogEnabled;

  const [step, setStep] = useState<CreateStep>("source");
  const effectiveStep: CreateStep =
    catalogDisabled && step === "source" ? "configure" : step;
  const [draft, setDraft] = useState<SkillDraft>(blankSkillDraft);
  const blankDraft = useMemo(() => blankSkillDraft(), []);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const patchDraft = (patch: Partial<SkillDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }));
  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );
  const contentComplete = parsed.hasName && parsed.hasDescription;
  const isDirty = useMemo(
    () => isSkillDraftDirty(draft, blankDraft),
    [blankDraft, draft],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGuardBypassed, setIsGuardBypassed] = useState(false);
  const submittingRef = useRef(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(
    null,
  );
  const routedCreatedRef = useRef<string | null>(null);

  const createSkill = useCreateSkill();
  const handleCreate = async () => {
    if (
      submittingRef.current ||
      canCreate !== true ||
      !contentComplete ||
      createSkill.isPending
    )
      return;
    submittingRef.current = true;
    setIsSubmitting(true);
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? draft.labels;
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both keep the wizard where it is with the
    // draft intact, so the author can retry without retyping.
    const created = await createSkill
      .mutateAsync(buildSkillSaveBody({ ...draft, labels: finalLabels }, null))
      .catch(() => null);
    if (!created) {
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }
    setIsGuardBypassed(true);
    setDraft(blankDraft);
    setCreated({
      id: created.id,
      name: parsed.name?.trim() || "Skill",
    });
  };

  const guardedDirty = isDirty && !isGuardBypassed;
  useBeforeUnloadWhileDirty(guardedDirty);
  const pendingHrefRef = useRef<string | null>(null);
  const pendingImportRef = useRef<SkillImportState | null>(null);
  const isReadPermissionKnown = !isReadPermissionPending;
  const showsUnreadableSuccess =
    !!created && isReadPermissionKnown && canReadSkills !== true;
  useEffect(() => {
    if (
      !created ||
      !isReadPermissionKnown ||
      canReadSkills !== true ||
      routedCreatedRef.current === created.id
    )
      return;
    routedCreatedRef.current = created.id;
    router.push(`/skills/${created.id}`);
  }, [canReadSkills, created, isReadPermissionKnown, router]);
  const guard = useUnsavedChangesGuard({
    isDirty: guardedDirty,
    onOpenChange: (open) => {
      if (open) return;
      const pendingImport = pendingImportRef.current;
      pendingImportRef.current = null;
      if (pendingImport) {
        setIsGuardBypassed(false);
        setDraft(blankDraft);
        setStep("source");
        setImportState(pendingImport);
        return;
      }
      const href = pendingHrefRef.current;
      pendingHrefRef.current = null;
      if (href) {
        setIsGuardBypassed(true);
        setDraft(blankDraft);
        router.push(href);
      }
    },
  });
  const requestNavigate = useCallback(
    (href: string) => {
      if (submittingRef.current) return;
      pendingHrefRef.current = href;
      guard.requestClose();
    },
    [guard],
  );
  useGuardedInAppNavigation({
    isDirty: guardedDirty,
    onRequestNavigate: requestNavigate,
  });

  const requestImport = useCallback(
    (nextImport: SkillImportState) => {
      if (!isDirty) {
        setImportState(nextImport);
        return;
      }
      pendingImportRef.current = nextImport;
      guard.requestClose();
    },
    [guard, isDirty],
  );
  const openImport = () => requestImport({ repoUrl: "", autoDiscover: false });
  const importPopular = (repoUrl: string) =>
    requestImport({ repoUrl, autoDiscover: true });
  const importIndexedSkill = (skill: SkillCatalogResult) =>
    requestImport({
      repoUrl: skill.repo,
      autoDiscover: true,
      initialSkill: {
        skillPath: skill.skillPath,
        name: skill.name,
        description: skill.description,
        compatibility: skill.compatibility,
        fileCount: skill.fileCount,
      },
    });
  const goToSkills = () => router.push("/skills");
  const goToConfigureStep = () => setStep("configure");

  const catalogSearch = useSearchSkillCatalog(search);
  const skillResults = catalogSearch.data?.results ?? [];
  const skillTotalCount = catalogSearch.data?.totalCount ?? null;

  const filteredRepos = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return POPULAR_REPOS;
    return POPULAR_REPOS.filter(
      (item) =>
        item.repo.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q),
    );
  }, [search]);

  const isSearchingSkills = search.trim().length > 0;

  return (
    <>
      <PageWizard
        title="Add a new skill"
        description={STEP_DESCRIPTIONS[effectiveStep]}
        backLink={
          isSubmitting ? undefined : (
            <SkillBackLink href="/skills" label="Skills" />
          )
        }
        steps={
          created || effectiveStep !== "configure" ? undefined : CONFIGURE_STEPS
        }
        activeStep={effectiveStep === "configure" ? "configure" : undefined}
      >
        <div className="space-y-6">
          {showsUnreadableSuccess ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <CircleCheck />
                </EmptyMedia>
                <EmptyTitle>Skill created</EmptyTitle>
                <EmptyDescription>
                  <span>
                    &quot;{created?.name ?? "Skill"}&quot; was created. You do
                    not have permission to view it.
                  </span>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : created ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Loader2 className="animate-spin" />
                </EmptyMedia>
                <EmptyTitle>Skill created</EmptyTitle>
                <EmptyDescription>
                  Opening &quot;{created.name}&quot;…
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : isOrganizationPending ? null : (
            <>
              {effectiveStep === "source" && (
                <div className="mx-auto max-w-3xl space-y-8">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <CatalogSourceCard
                      icon={<Github className="size-5" />}
                      title="Custom GitHub URL"
                      description="Paste any repository with SKILL.md directories."
                      onClick={openImport}
                    />
                    <CatalogSourceCard
                      icon={<FileText className="size-5" />}
                      title="Blank template"
                      description="Write a SKILL.md manifest from scratch."
                      onClick={goToConfigureStep}
                    />
                  </div>

                  <Card className="gap-0 py-0">
                    <CardHeader className="gap-3 border-b py-4">
                      <div className="flex items-center justify-between gap-3">
                        <CardTitle className="text-base">
                          {isSearchingSkills
                            ? "Skill index"
                            : "Popular repositories"}
                        </CardTitle>
                        <Badge variant="secondary" className="tabular-nums">
                          {isSearchingSkills
                            ? `${skillResults.length} / ${skillTotalCount ?? "…"}`
                            : POPULAR_REPOS.length}
                        </Badge>
                      </div>
                      <FilterBar
                        onClearFilters={
                          search ? () => setSearch("") : undefined
                        }
                        search={
                          <SearchInput
                            value={search}
                            onSearchChange={setSearch}
                            syncQueryParams={false}
                            placeholder="Search skills by name, repo, or use case..."
                            className="w-full flex-1"
                          />
                        }
                      />
                    </CardHeader>
                    <CardContent className="p-0">
                      {isSearchingSkills ? (
                        catalogSearch.isLoading ? (
                          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                            <span>Searching the skill index…</span>
                          </div>
                        ) : catalogSearch.isError ? (
                          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                            <span>
                              Could not search the skill index. Try again.
                            </span>
                          </div>
                        ) : skillResults.length === 0 ? (
                          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                            <span>No indexed skills match “{search}”.</span>
                          </div>
                        ) : (
                          <ul>
                            {skillResults.map((skill, idx) => (
                              <li key={`${skill.repo}:${skill.skillPath}`}>
                                {idx > 0 && <Separator />}
                                <SkillIndexResult
                                  skill={skill}
                                  onClick={() => importIndexedSkill(skill)}
                                />
                              </li>
                            ))}
                          </ul>
                        )
                      ) : filteredRepos.length === 0 ? (
                        <div className="px-6 py-10 text-center text-sm text-muted-foreground">
                          No repositories match “{search}”.
                        </div>
                      ) : (
                        <ul>
                          {filteredRepos.map((item, idx) => {
                            const owner = item.repo.split("/")[0];
                            return (
                              <li key={item.repo}>
                                {idx > 0 && <Separator />}
                                <button
                                  type="button"
                                  onClick={() => importPopular(item.repo)}
                                  className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
                                >
                                  <Avatar className="size-8">
                                    <AvatarImage
                                      src={`https://github.com/${owner}.png?size=64`}
                                      alt=""
                                    />
                                    <AvatarFallback>
                                      <Github className="size-4 text-muted-foreground" />
                                    </AvatarFallback>
                                  </Avatar>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-mono text-sm font-medium">
                                      {item.repo}
                                    </div>
                                    <div className="truncate text-xs text-muted-foreground">
                                      {item.description}
                                    </div>
                                  </div>
                                  <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}

              {effectiveStep === "configure" && (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleCreate();
                  }}
                >
                  <SkillForm
                    draft={draft}
                    onChange={patchDraft}
                    readOnly={isSubmitting}
                    onFilesChange={(update) =>
                      setDraft((prev) => ({
                        ...prev,
                        files: update(prev.files),
                      }))
                    }
                    labelsRef={labelsRef}
                  />
                  <WizardFooter>
                    {catalogDisabled ? (
                      isSubmitting ? (
                        <Button variant="outline" type="button" disabled>
                          Cancel
                        </Button>
                      ) : (
                        <Button variant="outline" asChild>
                          <Link href="/skills">Cancel</Link>
                        </Button>
                      )
                    ) : (
                      <Button
                        variant="outline"
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => setStep("source")}
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Back
                      </Button>
                    )}
                    <PermissionButton
                      permissions={{ skill: ["create"] }}
                      type="submit"
                      disabled={
                        canCreate !== true ||
                        !contentComplete ||
                        createSkill.isPending ||
                        isSubmitting
                      }
                    >
                      {createSkill.isPending ? "Creating..." : "Create skill"}
                    </PermissionButton>
                  </WizardFooter>
                </form>
              )}
            </>
          )}
        </div>
      </PageWizard>

      <UnsavedChangesDialog
        open={guard.confirmOpen}
        onKeepEditing={() => {
          pendingHrefRef.current = null;
          pendingImportRef.current = null;
          guard.keepEditing();
        }}
        onDiscard={guard.discardChanges}
      />

      <ImportSkillsDialog
        open={importState !== null}
        initialRepoUrl={importState?.repoUrl ?? ""}
        initialSkill={importState?.initialSkill}
        autoDiscover={importState?.autoDiscover ?? false}
        onOpenChange={(open) => {
          if (!open) setImportState(null);
        }}
        onImported={goToSkills}
      />
    </>
  );
}

function SkillIndexResult({
  skill,
  onClick,
}: {
  skill: SkillCatalogResult;
  onClick: () => void;
}) {
  const owner = skill.repo.split("/")[0];
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
      aria-label={`Import ${skill.name} from ${skill.repo}`}
    >
      <Avatar className="size-8">
        <AvatarImage src={`https://github.com/${owner}.png?size=64`} alt="" />
        <AvatarFallback>
          <Github className="size-4 text-muted-foreground" />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <span className="shrink-0 rounded border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {skill.repo}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {skill.description}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/80">
          {skill.skillPath || "repo root"} · {skill.fileCount}{" "}
          {skill.fileCount === 1 ? "file" : "files"}
        </div>
      </div>
      <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
