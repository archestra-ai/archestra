"use client";

import { archestraApiSdk, type archestraApiTypes } from "@archestra/shared";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  RotateCcw,
  Share2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  SECRET_PLACEHOLDER_TOKEN,
  SecretCopyButton,
} from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type SkillShareLink,
  useCreateSkillShareLink,
  useListSkillShareLinks,
  useRevokeSkillShareLink,
  useRotateSkillShareLink,
  useSkillMarketplace,
} from "@/lib/skills/skill-share.query";
import { useFetchUserTokenValue } from "@/lib/user-token.query";
import { cn, handleApiError } from "@/lib/utils";
import type { ConnectClient } from "./clients";
import {
  computeSkillMarketplaceExpiresAt,
  SKILL_MARKETPLACE_CLIENTS,
  SKILL_MARKETPLACE_TTL_PRESETS,
  type SkillMarketplaceClient,
} from "./skills-marketplace-clients";
import { TerminalBlock } from "./terminal-block";

interface SkillsMarketplaceStepProps {
  client: ConnectClient;
}

type SkillMarketplace = NonNullable<
  archestraApiTypes.GetSkillMarketplaceResponses["200"]
>;

/**
 * Whether the skills marketplace step applies: the caller can read skills, and
 * the picked client supports installable marketplaces. The flow uses this for
 * wizard-step numbering; the component returns null without it.
 *
 * `skill:read`, not `skill:admin` — the static marketplace is something every
 * member installs for themselves. Minting share links stays admin-only, inside
 * the step.
 */
export function useSkillsMarketplaceVisible(
  client: ConnectClient | null,
): boolean {
  const { data: canRead } = useHasPermissions({ skill: ["read"] });
  return canRead === true && client !== null && isClientSupported(client);
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

export function SkillsMarketplaceStep({ client }: SkillsMarketplaceStepProps) {
  // hide the step entirely when skills don't apply to this user/client — the
  // wizard rail numbering in connection-flow uses the same hook.
  const visible = useSkillsMarketplaceVisible(client);
  if (!visible) return null;

  return <SkillsMarketplaceBody client={client} />;
}

function SkillsMarketplaceBody({ client }: { client: ConnectClient }) {
  const { data: marketplace, isPending: marketplacePending } =
    useSkillMarketplace();
  const { data: totalSkills, isPending: skillsPending } = useTotalSkillCount();
  const { data: canAdmin } = useHasPermissions({ skill: ["admin"] });

  if (marketplacePending || skillsPending) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Loading…</span>
      </div>
    );
  }

  if ((totalSkills ?? 0) === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        No skills available to you yet. Create one under{" "}
        <Link href="/skills" className="underline">
          Skills
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {marketplace ? (
        <StaticMarketplacePanel
          client={client}
          marketplace={marketplace}
          totalSkills={totalSkills ?? 0}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          The marketplace URL could not be loaded. Reload the page to try again.
        </p>
      )}
      {canAdmin === true && <ShareLinkSection client={client} />}
    </div>
  );
}

/**
 * The primary install path: one URL, the same for every user, installed with
 * the user's own credential.
 */
function StaticMarketplacePanel({
  client,
  marketplace,
  totalSkills,
}: {
  client: ConnectClient;
  marketplace: SkillMarketplace;
  totalSkills: number;
}) {
  const fetchUserToken = useFetchUserTokenValue();
  const credentialCommand = buildCredentialCommand(marketplace.cloneUrl);

  const resolveCredentialSecret = useCallback(async () => {
    const result = await fetchUserToken.mutateAsync();
    if (!result?.value) return null; // the mutation already surfaced a toast
    return credentialCommand.replaceAll(SECRET_PLACEHOLDER_TOKEN, result.value);
  }, [credentialCommand, fetchUserToken]);

  const clientSteps = pickClientsFor(client).flatMap((c) =>
    c.getInstallSteps({
      cloneUrl: marketplace.cloneUrl,
      marketplaceName: marketplace.marketplaceName,
    }),
  );

  return (
    <section
      className="flex flex-col gap-5"
      data-testid="skills-marketplace-static"
    >
      {marketplace.requiresAuthentication ? (
        <p className="text-sm text-muted-foreground">
          {totalSkills} skill{totalSkills === 1 ? null : <span>s</span>} are
          available to you here. This URL is the same for everyone and never
          expires: share it, or pre-configure it in every client. Each person
          installs it with their own credential and gets the skills they can
          see.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          This URL is the same for everyone and never expires: share it, or
          pre-configure it in every client. It needs no credential and carries
          the organization-wide skills.
        </p>
      )}

      <ol className="grid gap-5">
        {clientSteps.length === 0 ? (
          <NumberedStep
            index={1}
            title="Point your client at the marketplace"
            body="Each skill is a plugins/<marketplace>/skills/<name>/SKILL.md directory inside the repository. Register the URL however your client's marketplace or skill-import flow expects. For Claude Code, Codex, Copilot CLI, or Cursor, pick that client at the top of this page for the exact commands."
            code={`git clone ${marketplace.cloneUrl} ~/.archestra/skills/${marketplace.marketplaceName}`}
          />
        ) : (
          clientSteps.map((step, idx) => (
            <NumberedStep
              key={step.label}
              index={idx + 1}
              title={step.label}
              body={step.body}
              code={step.code}
            />
          ))
        )}
      </ol>

      {marketplace.requiresAuthentication ? (
        <CredentialNote
          credentialCommand={credentialCommand}
          resolveCredentialSecret={resolveCredentialSecret}
        />
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          This deployment publishes the marketplace without authentication, so
          no sign-in is needed. Personal and team skills are never part of that
          view.
        </p>
      )}
    </section>
  );
}

/**
 * What to do when git cannot ask for a password. The common case needs none of
 * this: git prompts on the first fetch and the credential helper remembers the
 * answer, and the generated setup command carries its own credential — so this
 * is a footnote, not a step.
 */
function CredentialNote({
  credentialCommand,
  resolveCredentialSecret,
}: {
  credentialCommand: string;
  resolveCredentialSecret: () => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-sm font-medium text-foreground"
          data-testid="skills-marketplace-credential-toggle"
        >
          <ChevronRight
            className={cn("h-4 w-4 transition-transform", open && "rotate-90")}
          />
          <span>Your client can&apos;t prompt for a password?</span>
          <span className="font-normal text-muted-foreground">
            store the credential up front
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">
        <p className="pb-3 text-[12.5px] text-muted-foreground">
          git asks for a username and password the first time your client
          fetches the marketplace: any username works, and your personal token
          is the password. A client that runs git without a terminal never gets
          that prompt, so store the credential first (needs a git credential
          helper, e.g. your OS keychain). Your token lives in{" "}
          <Link
            href="/account?highlight=personal-token"
            className="underline hover:text-foreground"
          >
            Personal Settings
          </Link>
          .
        </p>
        <TerminalBlock
          rows={[
            { code: credentialCommand, getSecretText: resolveCredentialSecret },
          ]}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Token-in-the-URL share links, kept for sharing a fixed snapshot with people
 * who have no account on this deployment. Admin-only, and secondary to the
 * static URL above — hence the disclosure.
 */
function ShareLinkSection({ client }: { client: ConnectClient }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t pt-4">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 text-left text-sm font-medium text-foreground"
          data-testid="skills-marketplace-share-link-toggle"
        >
          <ChevronRight
            className={cn("h-4 w-4 transition-transform", open && "rotate-90")}
          />
          <span>Share a snapshot link instead</span>
          <span className="font-normal text-muted-foreground">
            for people without an account here
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-4">
        <ShareLinkPanel client={client} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function ShareLinkPanel({ client }: { client: ConnectClient }) {
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
        <span>Loading…</span>
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
        onRevoked={() => setRevealed(null)}
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
    const skillIds = (await fetchAllSkills()).map((s) => s.id);
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
        Snapshot {totalSkills} skill
        {totalSkills === 1 ? null : <span>s</span>} into a single marketplace
        URL that carries its own token, so it works without an account here. New
        skills added later won't appear until you refresh the link.
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
  onRevoked,
}: {
  client: ConnectClient;
  /** May be null in the brief window between create-mutation and list refetch. */
  link: SkillShareLink | null;
  totalSkills: number;
  revealed: RevealedClone | null;
  onReveal: (revealed: RevealedClone) => void;
  onRevoked: () => void;
}) {
  const revokeShare = useRevokeSkillShareLink();
  const rotateShare = useRotateSkillShareLink();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  // rotation creates a replacement link and revokes the previous one — it must
  // stay behind an explicit click. auto-rotation on unfold would invalidate URLs
  // already stored in users' git configs without the admin asking for it.
  const handleRotate = useCallback(async () => {
    if (!link) return;
    const skillIds = (await fetchAllSkills()).map((s) => s.id);
    if (skillIds.length === 0) return;
    const result = await rotateShare.mutateAsync({
      previousLinkId: link.id,
      body: { skillIds, expiresAt: link.expiresAt },
    });
    if (!result) return;
    onReveal({
      linkId: result.link.id,
      cloneUrl: result.cloneUrl,
      marketplaceName: result.marketplaceName,
    });
  }, [rotateShare, link, onReveal]);

  const handleRevoke = useCallback(async () => {
    if (!link) return;
    await revokeShare.mutateAsync(link.id);
    setConfirmRevoke(false);
    // drop the revealed clone URL so the parent falls back to the create
    // panel once the list refetch confirms no active link remains.
    onRevoked();
  }, [revokeShare, link, onRevoked]);

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

      {link && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
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
          {!confirmRevoke ? (
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
      )}
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
          body="Skills live under skills/<name>/SKILL.md inside the cloned repo. Point your client at the clone path however its marketplace or skill-import flow expects."
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
  getSecretText,
  footer,
}: {
  index: number;
  title: string;
  body?: string;
  code?: string;
  /** When set, the code block offers "copy with the real token" (see TerminalBlock). */
  getSecretText?: () => Promise<string | null>;
  footer?: React.ReactNode;
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
        {code && <TerminalBlock rows={[{ code, getSecretText }]} />}
        {footer}
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

/**
 * A `git credential approve` heredoc for the marketplace host, so a client
 * that shells out to git without a terminal still authenticates. The token is
 * a placeholder on screen; SecretCopyButton substitutes the real one on copy.
 */
function buildCredentialCommand(cloneUrl: string): string {
  let protocol = "https";
  let host = "";
  try {
    const url = new URL(cloneUrl);
    protocol = url.protocol.replace(":", "");
    host = url.host;
  } catch {
    host = cloneUrl;
  }
  return [
    "git credential approve <<'EOF'",
    `protocol=${protocol}`,
    `host=${host}`,
    // any username works — the token is the credential
    "username=token",
    `password=${SECRET_PLACEHOLDER_TOKEN}`,
    "EOF",
  ].join("\n");
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
  // Callers fall back to a generic clone-path guide instead.
  if (client.id === "generic") return [];
  return SKILL_MARKETPLACE_CLIENTS.filter((c) => c.id === client.id);
}

function firstActiveLink(links: SkillShareLink[]): SkillShareLink | null {
  return links.find((l) => l.status === "active") ?? null;
}

/**
 * The slice of a skill the connection flow needs to list, attribute, and share
 * it. Derived from the API response so the fields can't drift from it.
 */
export type ConnectSkill = Pick<
  archestraApiTypes.GetSkillsResponses["200"]["data"][number],
  "id" | "name" | "scope" | "authorId" | "authorName" | "teams" | "users"
>;

/**
 * Query over the org's full skill set, for the connect-command step's
 * per-skill picker. Soft-fails to an empty list (with the API-error
 * toast) so a skills outage degrades to "no skills ride along" instead of
 * blocking command generation.
 *
 * `forAgentId` narrows the set to skills visible from that agent's
 * environment — the connect command passes the selected LLM proxy so only
 * skills the connection can actually reach are offered.
 */
export function useAllSkills(params?: {
  enabled?: boolean;
  forAgentId?: string | null;
}) {
  const forAgentId = params?.forAgentId ?? null;
  return useQuery({
    queryKey: ["skills", "connect-all", forAgentId],
    queryFn: () => fetchAllSkills(forAgentId),
    enabled: params?.enabled,
  });
}

/** Fetch every skill page by page; on error, toast and return what we have. */
async function fetchAllSkills(
  forAgentId: string | null = null,
): Promise<ConnectSkill[]> {
  const skills: ConnectSkill[] = [];
  const limit = 100;
  let offset = 0;
  while (true) {
    const { data, error } = await archestraApiSdk.getSkills({
      query: { limit, offset, forAgentId: forAgentId ?? undefined },
    });
    if (error) {
      handleApiError(error);
      return [];
    }
    if (!data) break;
    for (const skill of data.data) {
      skills.push({
        id: skill.id,
        name: skill.name,
        scope: skill.scope,
        authorId: skill.authorId,
        authorName: skill.authorName,
        teams: skill.teams,
        users: skill.users,
      });
    }
    if (data.data.length < limit) break;
    offset += limit;
  }
  return skills;
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
