"use client";

import {
  AlertTriangle,
  ChartColumn,
  Github,
  History,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useId, useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
import { CopyButton } from "@/components/copy-button";
import { PageLayout } from "@/components/page-layout";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth/auth.query";
import { formatPermissionConstraint } from "@/lib/auth/auth.utils";
import {
  ACTION_LABEL,
  backToListLabel,
  FIELD_LABEL,
  formatCreated,
  notYoursToChange,
} from "@/lib/design/resource-lexicon";
import { typeRole } from "@/lib/design/type-scale";
import { useAppName } from "@/lib/hooks/use-app-name";
import { composeManifest } from "@/lib/skills/manifest-compose";
import { useSkill } from "@/lib/skills/skill.query";
import { useSkillAccess } from "@/lib/skills/use-skill-access";
import { cn, formatDate } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { ChatWithSkillButton } from "../_parts/chat-with-skill-button";
import { DeleteSkillDialog } from "../_parts/delete-skill-dialog";
import type { SkillDetail } from "../_parts/github-sync-panel";
import {
  SKILL_PAGE_EDITOR_CLASS,
  SkillContentEditor,
} from "../_parts/skill-content-editor";
import { isSyncedGithubSkill } from "../_parts/skill-draft";
import {
  SKILL_DESCRIPTION_FALLBACK,
  skillEditHref,
  skillGithubSourceRepo,
} from "../_parts/skill-page-config";
import {
  SkillBackLink,
  SkillNotFound,
  SkillPageLoading,
} from "../_parts/skill-page-shell";
import { SkillUsageDialog } from "../_parts/skill-usage-dialog";
import { SkillVersionHistoryDialog } from "../_parts/skill-version-history-dialog";

/**
 * `/skills/[id]` — the skill as it is: its facts, then its content, read-only.
 * Changing anything goes through the page header's Edit, which opens the
 * wizard (the create wizard's Content and Access steps on the existing
 * skill). Version history, usage, chat and delete sit in the header too.
 */
export function SkillDetailPage({ id }: { id: string }) {
  const router = useRouter();
  const { data: skill, isPending } = useSkill(id);

  // Deleting invalidates the skills queries, and the refetch resolves to null
  // before the navigation back to the list has finished — without the flag the
  // page would flash "Skill not found" for a delete that just succeeded.
  const [isLeavingAfterDelete, setIsLeavingAfterDelete] = useState(false);

  if (isPending || (isLeavingAfterDelete && !skill))
    return <SkillPageLoading />;
  if (!skill) return <SkillNotFound />;

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

function SkillDetailView({
  skill,
  onDeleted,
}: {
  skill: SkillDetail;
  onDeleted: () => void;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  // RBAC alone showed Edit and Delete to any `skill:update`/`skill:delete`
  // holder, whoever the skill belonged to, and the save came back 403.
  const {
    canModify,
    canUpdate,
    canEdit,
    canDelete,
    isPending: isAccessPending,
  } = useSkillAccess(skill);
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
  const deleteReasonId = useId();

  const isGithubSkill = skill.sourceType === "github";
  // A team- or user-shared skill has names the scope badge cannot carry; a
  // private one has nothing to add.
  const isShared = skill.teams.length > 0 || (skill.users ?? []).length > 0;
  const manifest = useMemo(() => composeManifest(skill), [skill]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [deleteRequested, setDeleteRequested] = useState(false);

  return (
    <PageLayout
      title={
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{skill.name}</span>
          <AgentBadge type={skill.scope} className="font-normal" />
          {isGithubSkill && (
            <Badge variant="secondary" className="gap-1 font-normal">
              <Github className="h-3 w-3" />
              {isSyncedGithubSkill(skill)
                ? "Synced from GitHub"
                : "Imported from GitHub"}
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
      backLink={
        <SkillBackLink href="/skills" label={backToListLabel("skill")} />
      }
      maxWidth="wizard"
      actionButton={
        // One primary (Edit), one secondary (Chat), everything else in the
        // kebab with the destructive item under a divider. This header used to
        // carry four buttons — Chat, History, Usage, Edit — where the agent
        // pages carry two, which made the same header look like a different
        // product on each page.
        <div className="flex shrink-0 items-center gap-2">
          <ChatWithSkillButton skillId={skill.id} />
          {/* Undecided is not refused: while the permission reads are in flight
              the header holds the button's space rather than telling the
              skill's own author it is not theirs. */}
          {isAccessPending ? (
            <Skeleton className="h-9 w-20" />
          ) : canEdit ? (
            <PermissionButton permissions={{ skill: ["update"] }} asChild>
              <Link href={skillEditHref(skill.id)}>
                <Pencil className="h-4 w-4" />
                {ACTION_LABEL.edit}
              </Link>
            </PermissionButton>
          ) : (
            // Refused, not removed: a reader who simply cannot see Edit has no
            // way to learn the skill is not theirs to change.
            <PermissionButton
              permissions={{ skill: ["update"] }}
              disabled={canUpdate}
              tooltip={canUpdate ? notYours : undefined}
            >
              <Pencil className="h-4 w-4" />
              {ACTION_LABEL.edit}
            </PermissionButton>
          )}
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
                {ACTION_LABEL.versionHistory}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                <ChartColumn className="h-4 w-4" />
                Usage
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
                {ACTION_LABEL.delete}
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
      {/* One card per subject, the wizard's column wide and in the wizard's
          order: what the skill says, then who may use it, then the record
          itself. The page's single Edit lives in the header. */}
      <div className="space-y-4">
        <SkillCard title="Instructions and files" spacious>
          <SkillContentEditor
            manifest={manifest}
            files={skill.files}
            onManifestChange={noop}
            onFilesChange={noop}
            readOnly
            readOnlyMarker={false}
            className={SKILL_PAGE_EDITOR_CLASS}
          />
        </SkillCard>

        <SkillCard title="Who can use it">
          <FactGrid>
            <Fact label={FIELD_LABEL.environment}>
              {skill.environments.length === 0 ? (
                <span>All environments</span>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {skill.environments.map((environment) => (
                    <li key={environment.id}>
                      <Badge variant="outline" className="font-normal">
                        {environment.name}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Fact>
            {/* Only when the badge has something the page title's scope badge
                does not already carry. "Accessible to: Me" on a page only its
                owner can open was a tautology. */}
            {isShared && (
              <Fact label="Shared with">
                <ResourceVisibilityBadge
                  scope={skill.scope}
                  teams={skill.teams}
                  users={skill.users}
                  authorId={skill.authorId}
                  authorName={undefined}
                  currentUserId={currentUserId}
                  showSelfAsMe={false}
                />
              </Fact>
            )}
          </FactGrid>
        </SkillCard>

        {/* The last change is a date only: a skill row records when it changed,
            never by whom, and its author is not resolvable on this page. */}
        <SkillCard title="Details">
          <FactGrid>
            <Fact label="ID">
              <span className="flex min-w-0 items-center gap-1">
                <code
                  className={cn(typeRole({ role: "code" }), "min-w-0 truncate")}
                >
                  {skill.id}
                </code>
                <CopyButton text={skill.id} className="shrink-0" />
              </span>
            </Fact>
            <Fact label="Source">
              <SourceFact skill={skill} />
            </Fact>
            <Fact label="Version">
              <span>v{skill.latestVersion}</span>
            </Fact>
            <Fact label="Used">
              {skill.usageCount === 0 ? (
                <span>Never</span>
              ) : (
                <span>
                  {skill.usageCount} {skill.usageCount === 1 ? "time" : "times"}
                  {skill.lastUsedAt ? (
                    <span>
                      {" "}
                      · last{" "}
                      {formatRelativeTimeFromNow(
                        skill.lastUsedAt,
                      ).toLowerCase()}
                    </span>
                  ) : null}
                </span>
              )}
            </Fact>
            <Fact label={FIELD_LABEL.created}>
              <span>{formatCreated({ createdAt: skill.createdAt })}</span>
            </Fact>
            <Fact label={FIELD_LABEL.lastUpdated}>
              <span>
                {formatDate({ date: skill.updatedAt, dateFormat: "PP" })}
              </span>
            </Fact>
          </FactGrid>
        </SkillCard>
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
          skillRef={{ kind: "standalone", skillId: skill.id }}
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

/** Where the skill's content comes from, and for a synced one, how it keeps up. */
function SourceFact({ skill }: { skill: SkillDetail }) {
  const appName = useAppName();
  if (skill.sourceType === "built_in") {
    return <span>Ships with {appName}</span>;
  }
  if (skill.sourceType !== "github") {
    return <span>Written in {appName}</span>;
  }
  const repo = skillGithubSourceRepo(skill);
  const synced = isSyncedGithubSkill(skill);
  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <Github className="size-4 shrink-0 text-muted-foreground" />
        {repo ? (
          <a
            href={`https://github.com/${repo}${synced && skill.githubSyncRef ? `/tree/${skill.githubSyncRef}` : ""}`}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate font-mono underline underline-offset-4 hover:text-primary"
            title="Open on GitHub"
          >
            {repo}
            {synced && skill.githubSyncRef ? (
              <span className="text-muted-foreground">
                {" "}
                @ {skill.githubSyncRef}
              </span>
            ) : null}
          </a>
        ) : (
          <span>GitHub</span>
        )}
      </div>
      <p className={typeRole({ role: "meta" })}>
        {synced ? (
          skill.lastSyncError ? (
            <span className="text-destructive">
              <AlertTriangle className="mr-1 inline size-3 align-[-2px]" />
              {`Synced ${syncIntervalLabel(skill.githubSyncInterval)} — last sync failed ${formatRelativeTimeFromNow(skill.lastSyncedAt).toLowerCase()}`}
            </span>
          ) : (
            <span>
              {`Synced ${syncIntervalLabel(skill.githubSyncInterval)} — last synced ${formatRelativeTimeFromNow(skill.lastSyncedAt, { neverLabel: "never" }).toLowerCase()}`}
            </span>
          )
        ) : (
          <span>Imported once; not kept in sync</span>
        )}
      </p>
    </div>
  );
}

/** One subject card. Editing starts from the page header, not each card. */
function SkillCard({
  title,
  spacious = false,
  children,
}: {
  title: string;
  spacious?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "space-y-4 rounded-lg border bg-card",
        spacious ? "p-6" : "p-4",
      )}
    >
      <h2 className={typeRole({ role: "section-title" })}>{title}</h2>
      {children}
    </section>
  );
}

function FactGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className={typeRole({ role: "label" })}>{label}</div>
      <div className={cn(typeRole({ role: "body" }), "break-words")}>
        {children}
      </div>
    </div>
  );
}

const noop = () => {};

// lowercase: these render mid-sentence ("Synced every hour — last synced …")
const SYNC_INTERVAL_LABELS: Record<string, string> = {
  "15m": "every 15 minutes",
  "1h": "every hour",
  "1d": "once a day",
};

function syncIntervalLabel(interval: string | null) {
  return (interval && SYNC_INTERVAL_LABELS[interval]) || "on a schedule";
}
