"use client";

import {
  ArrowLeft,
  ChartColumn,
  FileX,
  Github,
  History,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { PermissionButton } from "@/components/ui/permission-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { parseManifestFields } from "@/lib/skills/manifest-compose";
import { useSkill, useUpdateSkill } from "@/lib/skills/skill.query";
import { cn } from "@/lib/utils";
import { ChatWithSkillButton } from "../_parts/chat-with-skill-button";
import { DeleteSkillDialog } from "../_parts/delete-skill-dialog";
import {
  GithubSnapshotNotice,
  GithubSyncPanel,
  type SkillDetail,
} from "../_parts/github-sync-panel";
import { SkillAccessFields } from "../_parts/skill-access-fields";
import { SkillContentEditor } from "../_parts/skill-content-editor";
import {
  buildSkillSaveBody,
  isSkillDraftDirty,
  isSyncedGithubSkill,
  type SkillDraft,
  skillDraftFromSkill,
} from "../_parts/skill-draft";
import { SkillUsageDialog } from "../_parts/skill-usage-dialog";
import { SkillVersionHistoryDialog } from "../_parts/skill-version-history-dialog";

type DetailTab = "content" | "access";

const SKILL_DESCRIPTION_FALLBACK =
  "A skill is a SKILL.md instruction set plus optional resource files.";

export function SkillDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { data: skill, isPending } = useSkill(id);

  // Deleting invalidates the skills queries, and the refetch resolves to null
  // before the navigation back to the list has finished — without the flag the
  // page would flash "Skill not found" for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);

  if (isPending || (isLeavingAfterDelete && !skill)) {
    return (
      <PageLayout title="Skill" description="" backLink={<BackToSkillsLink />}>
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </PageLayout>
    );
  }

  if (!skill) {
    return (
      <PageLayout title="Skill" description="" backLink={<BackToSkillsLink />}>
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileX />
            </EmptyMedia>
            <EmptyTitle>Skill not found</EmptyTitle>
            <EmptyDescription>
              This skill may have been deleted, or you may not have access to
              it.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageLayout>
    );
  }

  return (
    <SkillDetailView
      skill={skill}
      onDeleted={() => {
        setIsLeavingAfterDelete(true);
        router.push("/skills");
      }}
    />
  );
}

function BackToSkillsLink() {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 text-muted-foreground"
      asChild
    >
      <Link href="/skills">
        <ArrowLeft className="h-4 w-4" />
        Skills
      </Link>
    </Button>
  );
}

function SkillDetailView({
  skill,
  onDeleted,
}: {
  skill: SkillDetail;
  onDeleted: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canDelete } = useHasPermissions({ skill: ["delete"] });
  const updateSkill = useUpdateSkill();

  // The URL is the single source of truth for the tab, so a shared link and
  // the back button land on the same view.
  const tab: DetailTab =
    searchParams.get("tab") === "access" ? "access" : "content";
  const tabHref = (target: DetailTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (target === "content") {
      params.delete("tab");
    } else {
      params.set("tab", target);
    }
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
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
  const githubSourceRepo = isGithubSkill
    ? (skill.sourceRef?.split("@")[0] ?? null)
    : null;

  const parsed = useMemo(
    () => parseManifestFields(draft.manifest),
    [draft.manifest],
  );
  const isSaving = updateSkill.isPending;
  const canSave =
    isDirty && parsed.hasName && parsed.hasDescription && !isSaving;

  const handleSave = async () => {
    // The draft can move while the request is in flight, so what was sent is
    // what the new base records — anything typed meanwhile stays unsaved
    // rather than being counted as written.
    const submitted = draft;
    // A handled failure resolves to null and a rejection is reported by the
    // mutation's own `onError`; both leave the draft intact so the author can
    // retry without retyping.
    const saved = await updateSkill
      .mutateAsync({
        id: skill.id,
        body: buildSkillSaveBody(submitted, skill, base.version),
      })
      .catch(() => null);
    if (saved) setBase({ draft: submitted, version: saved.latestVersion });
  };

  const [historyOpen, setHistoryOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);

  // The badge falls back to "-" for another author's personal skill because
  // the detail read carries no author name; the header just omits it then.
  const showVisibilityBadge =
    skill.scope !== "personal" ||
    skill.authorId === currentUserId ||
    skill.users.length > 0;

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{skill.name}</span>
          {showVisibilityBadge && (
            <ResourceVisibilityBadge
              scope={skill.scope}
              teams={skill.teams}
              users={skill.users}
              authorId={skill.authorId}
              authorName={undefined}
              currentUserId={currentUserId}
              showSelfAsMe
            />
          )}
          {isGithubSkill && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Github className="h-3 w-3" />
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
      description={skill.description || SKILL_DESCRIPTION_FALLBACK}
      backLink={<BackToSkillsLink />}
      tabs={[
        { label: "Content", href: tabHref("content") },
        { label: "Access", href: tabHref("access") },
      ]}
      actionButton={
        <div className="flex shrink-0 items-center gap-2">
          <ChatWithSkillButton skillId={skill.id} />
          <Button variant="outline" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" />
            History
          </Button>
          <Button variant="outline" onClick={() => setUsageOpen(true)}>
            <ChartColumn className="h-4 w-4" />
            Usage
          </Button>
          {canDelete && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">More actions</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteRequested(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      }
    >
      <div className="flex flex-col rounded-lg border">
        <div className="flex min-h-0 flex-col gap-4 p-6">
          {tab === "content" &&
            (isSynced ? (
              <GithubSyncPanel skill={skill} sourceRepo={githubSourceRepo} />
            ) : (
              isGithubSkill && <GithubSnapshotNotice repo={githubSourceRepo} />
            ))}
          {/* Kept mounted across tabs: the open file, collapsed folders and
              the trash bin of soft-deleted files are the editor's own state,
              and a trip to Access is not a decision to drop them. */}
          <div
            className={cn(
              "flex min-h-0 flex-col",
              tab !== "content" && "hidden",
            )}
          >
            <SkillContentEditor
              manifest={draft.manifest}
              files={draft.files}
              onManifestChange={(manifest) => patchDraft({ manifest })}
              onFilesChange={(update) =>
                setDraft((prev) => ({ ...prev, files: update(prev.files) }))
              }
              readOnly={isSynced}
              className="h-[calc(100vh-24rem)] min-h-[28rem]"
            />
          </div>
          {tab === "access" && (
            <SkillAccessFields draft={draft} onChange={patchDraft} />
          )}
        </div>
        <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 rounded-b-lg border-t bg-background px-6 py-4">
          <div>
            {isDirty && !isSaving && (
              <Button variant="outline" onClick={discardChanges}>
                Discard changes
              </Button>
            )}
          </div>
          <PermissionButton
            permissions={{ skill: ["update"] }}
            disabled={!canSave}
            onClick={handleSave}
          >
            {isSaving ? "Saving..." : "Save skill"}
          </PermissionButton>
        </div>
      </div>

      {historyOpen && (
        <SkillVersionHistoryDialog
          skillId={skill.id}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
        />
      )}
      {usageOpen && (
        <SkillUsageDialog
          skillId={skill.id}
          skillName={skill.name}
          open={usageOpen}
          onOpenChange={setUsageOpen}
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
