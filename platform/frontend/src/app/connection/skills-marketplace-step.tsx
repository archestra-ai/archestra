"use client";

import { archestraApiSdk } from "@shared";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Loader2,
  RotateCcw,
  Share2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import {
  type SkillShareLink,
  useCreateSkillShareLink,
  useListSkillShareLinks,
  useRevokeSkillShareLink,
  useRotateSkillShareLink,
} from "@/lib/skills/skill-share.query";
import { handleApiError } from "@/lib/utils";
import type { ConnectClient } from "./clients";
import {
  computeSkillMarketplaceExpiresAt,
  SKILL_MARKETPLACE_CLIENTS,
  SKILL_MARKETPLACE_TTL_PRESETS,
  type SkillMarketplaceClient,
} from "./skills-marketplace-clients";
import { StepCard, type StepState } from "./step-card";
import { TerminalBlock } from "./terminal-block";

interface SkillsMarketplaceStepProps {
  client: ConnectClient | null;
  expanded: boolean;
  onToggle: (() => void) | undefined;
}

/**
 * Token-bearing clone URL kept in component state. The backend returns it
 * exactly once at create time; we never persist or re-fetch it elsewhere.
 */
interface RevealedClone {
  linkId: string;
  cloneUrl: string;
  marketplaceName: string;
}

export function SkillsMarketplaceStep({
  client,
  expanded,
  onToggle,
}: SkillsMarketplaceStepProps) {
  const skillsEnabled = useFeature("agentSkillsEnabled") === true;
  const { data: canAdmin } = useHasPermissions({ skill: ["admin"] });

  if (!skillsEnabled || !canAdmin) return null;

  // hide the step entirely when the picked client doesn't support installable
  // skill marketplaces — the user already knows their tool doesn't support it,
  // we don't need to apologize in the UI.
  if (client && !isClientSupported(client)) return null;

  const state: StepState = !client ? "todo" : expanded ? "active" : "todo";

  return (
    <StepCard
      hideStatus
      title="Install shared skills"
      state={state}
      expanded={expanded && !!client}
      onToggle={client ? onToggle : undefined}
    >
      {client && <SkillsMarketplaceBody client={client} />}
    </StepCard>
  );
}

function SkillsMarketplaceBody({ client }: { client: ConnectClient }) {
  const { data: links, isPending: linksPending } = useListSkillShareLinks();
  const { data: totalSkills, isPending: skillsPending } = useTotalSkillCount();
  const [revealed, setRevealed] = useState<RevealedClone | null>(null);

  const activeLink = useMemo(
    () => firstActiveLink(links?.links ?? []),
    [links],
  );

  if (linksPending || skillsPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  if ((totalSkills ?? 0) === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No skills to share yet. Create one under{" "}
        <Link href="/agents/skills" className="underline">
          Skills
        </Link>
        .
      </div>
    );
  }

  // `revealed` survives the brief window between create-mutation success and
  // the list refetch — render the snippets eagerly so the user never sees a
  // blank state right after clicking Create.
  if (activeLink || revealed) {
    return (
      <ExistingLinkPanel
        client={client}
        link={activeLink}
        totalSkills={totalSkills ?? 0}
        revealed={revealed}
        onReveal={setRevealed}
      />
    );
  }

  return (
    <CreateLinkPanel totalSkills={totalSkills ?? 0} onCreated={setRevealed} />
  );
}

function CreateLinkPanel({
  totalSkills,
  onCreated,
}: {
  totalSkills: number;
  onCreated: (revealed: RevealedClone) => void;
}) {
  const [ttlId, setTtlId] = useState<string>(
    SKILL_MARKETPLACE_TTL_PRESETS[0].id,
  );
  const createShare = useCreateSkillShareLink();

  const handleCreate = useCallback(async () => {
    const preset =
      SKILL_MARKETPLACE_TTL_PRESETS.find((p) => p.id === ttlId) ??
      SKILL_MARKETPLACE_TTL_PRESETS[0];
    const skillIds = await fetchAllSkillIds();
    if (skillIds.length === 0) return;
    const result = await createShare.mutateAsync({
      skillIds,
      expiresAt: computeSkillMarketplaceExpiresAt(preset.days),
    });
    if (result) {
      onCreated({
        linkId: result.link.id,
        cloneUrl: result.cloneUrl,
        marketplaceName: result.marketplaceName,
      });
    }
  }, [createShare, onCreated, ttlId]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Snapshot {totalSkills} skill{totalSkills === 1 ? "" : "s"} into a single
        marketplace URL. New skills added later won't appear until you refresh
        the link.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm font-medium" htmlFor="skill-marketplace-ttl">
          Expiration
        </label>
        <Select value={ttlId} onValueChange={setTtlId}>
          <SelectTrigger id="skill-marketplace-ttl" className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SKILL_MARKETPLACE_TTL_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          onClick={handleCreate}
          disabled={createShare.isPending}
          data-testid="skills-marketplace-create"
        >
          <Share2 className="mr-2 h-4 w-4" />
          {createShare.isPending ? "Creating…" : "Create marketplace link"}
        </Button>
      </div>
    </div>
  );
}

function ExistingLinkPanel({
  client,
  link,
  totalSkills,
  revealed,
  onReveal,
}: {
  client: ConnectClient;
  /** May be null in the brief window between create-mutation and list refetch. */
  link: SkillShareLink | null;
  totalSkills: number;
  revealed: RevealedClone | null;
  onReveal: (revealed: RevealedClone) => void;
}) {
  const revokeShare = useRevokeSkillShareLink();
  const rotateShare = useRotateSkillShareLink();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // rotation creates a replacement link and revokes the previous one — it must
  // stay behind an explicit click. auto-rotation on unfold would invalidate URLs
  // already stored in users' git configs without the admin asking for it.
  const handleRotate = useCallback(async () => {
    if (!link) return;
    const skillIds = await fetchAllSkillIds();
    if (skillIds.length === 0) return;
    const result = await rotateShare.mutateAsync({
      previousLinkId: link.id,
      body: { skillIds, expiresAt: link.expiresAt },
    });
    if (!result?.created) return;
    onReveal({
      linkId: result.created.link.id,
      cloneUrl: result.created.cloneUrl,
      marketplaceName: result.created.marketplaceName,
    });
  }, [rotateShare, link, onReveal]);

  const handleRevoke = useCallback(async () => {
    if (!link) return;
    await revokeShare.mutateAsync(link.id);
    setConfirmRevoke(false);
  }, [revokeShare, link]);

  const linkSkillCount = link?.skills.length ?? totalSkills;
  const stale = link !== null && linkSkillCount !== totalSkills;
  const visibleClients = pickClientsFor(client);

  return (
    <div className="flex flex-col gap-5">
      {stale && (
        <StaleNotice
          linkSkillCount={linkSkillCount}
          totalSkills={totalSkills}
        />
      )}

      {revealed ? (
        <RevealedLinkSnippets
          clients={visibleClients}
          cloneUrl={revealed.cloneUrl}
          marketplaceName={revealed.marketplaceName}
        />
      ) : (
        <HiddenLinkNote />
      )}

      <SecurityNote />

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        {link && (
          <Button
            type="button"
            variant="outline"
            onClick={handleRotate}
            disabled={rotateShare.isPending}
            data-testid="skills-marketplace-rotate"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {rotateShare.isPending
              ? "Refreshing…"
              : revealed
                ? "Refresh link"
                : "Refresh to reveal URL"}
          </Button>
        )}
        {link && !confirmRevoke ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmRevoke(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Revoke
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              Revoke and block all existing clones?
            </span>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmRevoke(false)}
              disabled={revokeShare.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleRevoke}
              disabled={revokeShare.isPending}
              data-testid="skills-marketplace-confirm-revoke"
            >
              {revokeShare.isPending ? "Revoking…" : "Confirm revoke"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function StaleNotice({
  linkSkillCount,
  totalSkills,
}: {
  linkSkillCount: number;
  totalSkills: number;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-amber-900 dark:text-amber-100">
        The marketplace covers {linkSkillCount} of {totalSkills} current skills.
        Refresh to bring it up to date.
      </p>
    </div>
  );
}

function HiddenLinkNote() {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
      The clone URL is only shown once at creation, for security. Refresh the
      link to generate a new URL and install snippets.
    </div>
  );
}

function RevealedLinkSnippets({
  clients,
  cloneUrl,
  marketplaceName,
}: {
  clients: SkillMarketplaceClient[];
  cloneUrl: string;
  marketplaceName: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {clients.length === 0 ? (
        <GenericInstallNote
          cloneUrl={cloneUrl}
          marketplaceName={marketplaceName}
        />
      ) : (
        clients.map((c) => (
          <ClientInstallSnippets
            key={c.id}
            client={c}
            cloneUrl={cloneUrl}
            marketplaceName={marketplaceName}
          />
        ))
      )}
    </div>
  );
}

function GenericInstallNote({
  cloneUrl,
  marketplaceName,
}: {
  cloneUrl: string;
  marketplaceName: string;
}) {
  const localPath = `~/.archestra/skills/${marketplaceName}`;
  const cloneCmd = `git clone ${cloneUrl} ${localPath}`;
  return (
    <section data-testid="skills-marketplace-snippets-generic">
      <ol className="grid gap-5">
        <NumberedStep
          index={1}
          title="Clone the marketplace to a canonical path"
          body="Skills live under skills/<name>/SKILL.md inside the cloned repo — point your client at the clone path however its marketplace or skill-import flow expects."
          code={cloneCmd}
        />
        <NumberedStep
          index={2}
          title="Follow your client's marketplace docs"
          body={`Point your client at ${localPath} (or the clone URL above) using whichever local-marketplace / skills-import flow it supports. For Claude Code, Codex, or Cursor, pick that client at the top of this page for the exact commands.`}
        />
      </ol>
    </section>
  );
}

function ClientInstallSnippets({
  client,
  cloneUrl,
  marketplaceName,
}: {
  client: SkillMarketplaceClient;
  cloneUrl: string;
  marketplaceName: string;
}) {
  const steps = client.getInstallSteps({ cloneUrl, marketplaceName });
  return (
    <section data-testid={`skills-marketplace-snippets-${client.id}`}>
      <ol className="grid gap-5">
        {steps.map((step, idx) => (
          <NumberedStep
            key={`${client.id}-${step.label}`}
            index={idx + 1}
            title={step.label}
            body={step.body}
            code={step.code}
          />
        ))}
      </ol>
    </section>
  );
}

function NumberedStep({
  index,
  title,
  body,
  code,
}: {
  index: number;
  title: string;
  body?: string;
  code?: string;
}) {
  return (
    <li className="grid grid-cols-[22px_1fr] items-start gap-3">
      <div className="mt-0.5 flex size-[22px] shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {index}
      </div>
      <div className="min-w-0 space-y-3">
        <div>
          <div className="text-[13.5px] font-medium text-foreground">
            {title}
          </div>
          {body && (
            <div className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
              {body}
            </div>
          )}
        </div>
        {code && <TerminalBlock code={code} />}
      </div>
    </li>
  );
}

function SecurityNote() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-amber-900 dark:text-amber-100">
        The clone URL embeds a token. Anyone who holds the URL can install the
        marketplace until you revoke the link; the token is stored in the user's
        local git config after they run the marketplace add command.
      </p>
    </div>
  );
}

function isClientSupported(client: ConnectClient | null): boolean {
  if (!client) return false;
  return (
    client.id === "claude-code" ||
    client.id === "codex" ||
    client.id === "copilot-cli" ||
    client.id === "cursor" ||
    client.id === "generic"
  );
}

function pickClientsFor(client: ConnectClient): SkillMarketplaceClient[] {
  // "Any client" → user explicitly picked something other than the listed
  // ones, so showing Claude / Codex / Cursor install snippets is just noise.
  // RevealedLinkSnippets falls back to a generic clone-path guide instead.
  if (client.id === "generic") return [];
  return SKILL_MARKETPLACE_CLIENTS.filter((c) => c.id === client.id);
}

function firstActiveLink(links: SkillShareLink[]): SkillShareLink | null {
  return links.find((l) => l.status === "active") ?? null;
}

async function fetchAllSkillIds(): Promise<string[]> {
  const ids: string[] = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const { data, error } = await archestraApiSdk.getSkills({
      query: { limit, offset },
    });
    if (error) {
      handleApiError(error);
      return [];
    }
    if (!data) break;
    for (const skill of data.data) ids.push(skill.id);
    if (data.data.length < limit) break;
    offset += limit;
  }
  return ids;
}

function useTotalSkillCount() {
  return useQuery({
    queryKey: ["skills", "total-count"],
    queryFn: async () => {
      const { data, error } = await archestraApiSdk.getSkills({
        query: { limit: 1, offset: 0 },
      });
      if (error) {
        handleApiError(error);
        return 0;
      }
      return data?.pagination.total ?? 0;
    },
  });
}
