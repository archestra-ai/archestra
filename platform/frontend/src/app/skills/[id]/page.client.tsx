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
import { type ReactNode, useMemo, useState } from "react";
import { AgentBadge } from "@/components/agent-badge";
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
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { composeManifest } from "@/lib/skills/manifest-compose";
import { useSkill } from "@/lib/skills/skill.query";
import { formatDate } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { ChatWithSkillButton } from "../_parts/chat-with-skill-button";
import { DeleteSkillDialog } from "../_parts/delete-skill-dialog";
import type { SkillDetail } from "../_parts/github-sync-panel";
import { SkillContentEditor } from "../_parts/skill-content-editor";
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
  const { data: canDelete } = useHasPermissions({ skill: ["delete"] });
  const { data: canUpdate } = useHasPermissions({ skill: ["update"] });

  const isGithubSkill = skill.sourceType === "github";
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
      backLink={<SkillBackLink href="/skills" label="Skills" />}
      maxWidth="wizard"
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
          {canUpdate && (
            <Button asChild>
              <Link href={skillEditHref(skill.id)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Link>
            </Button>
          )}
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
      {/* One panel, the wizard's column wide: the skill's facts as its
          heading section, then the wizard's Content step read-only — who can
          use it (its Access step) is among the facts. */}
      <div className="divide-y rounded-lg border bg-card">
        <section className="grid gap-x-6 gap-y-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Accessible to">
            <ResourceVisibilityBadge
              scope={skill.scope}
              teams={skill.teams}
              users={skill.users}
              authorId={skill.authorId}
              authorName={undefined}
              currentUserId={currentUserId}
              showSelfAsMe
            />
          </Fact>
          <Fact label="Environments">
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
                  <span className="text-muted-foreground">
                    {" "}
                    · last{" "}
                    {formatRelativeTimeFromNow(skill.lastUsedAt).toLowerCase()}
                  </span>
                ) : null}
              </span>
            )}
          </Fact>
          <Fact label="Created">
            <span>
              {formatDate({ date: skill.createdAt, dateFormat: "PP" })}
            </span>
          </Fact>
          {skill.updatedAt !== skill.createdAt && (
            <Fact label="Last updated">
              <span>
                {formatDate({ date: skill.updatedAt, dateFormat: "PPp" })}
              </span>
            </Fact>
          )}
        </section>

        {/* The wizard's own Content step, so its heading ranks a level
            above sections inside a step (h2 to their h3). */}
        <section className="space-y-4 p-4 pt-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold tracking-tight">Content</h2>
            <p className="text-xs text-muted-foreground">
              The SKILL.md instruction set beside its resource files.
            </p>
          </div>
          <SkillContentEditor
            manifest={manifest}
            files={skill.files}
            onManifestChange={noop}
            onFilesChange={noop}
            readOnly
            readOnlyMarker={false}
            className="h-[calc(100vh-28rem)] min-h-[24rem]"
          />
        </section>
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
      <p className="text-xs text-muted-foreground">
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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="break-words">{children}</div>
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
