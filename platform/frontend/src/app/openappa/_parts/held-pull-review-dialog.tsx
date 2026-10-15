"use client";

import {
  type archestraApiTypes,
  DocsPage,
  getDocsUrl,
} from "@archestra/shared";
import {
  ArrowRight,
  ExternalLink,
  GitPullRequestArrow,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { SettingsLink } from "@/components/settings-link";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DialogCancelButton } from "@/components/unsaved-changes-guard";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useAcceptHeldPull,
  useBatteries,
} from "@/lib/openappa-batteries.query";
import {
  useAppaGithubSync,
  useHeldPullDetails,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { BatteryIcon } from "./battery-icon";
import { DialogSection } from "./dialog-section";

/**
 * A held pull, laid out for a decision: what each battery would read and which
 * batteries would go. Declining has no button here; the repository is the
 * source of truth, so the way to say no is to change the policy there.
 */
export function HeldPullReviewDialog({
  mayApprove,
  onClose,
}: {
  mayApprove: boolean;
  onClose: () => void;
}) {
  const details = useHeldPullDetails(true);
  const accept = useAcceptHeldPull();
  const { data: sync } = useAppaGithubSync();
  const label = sync ? "GitHub" : "the repository";
  const source = sync?.source ?? null;
  const urls =
    source?.repo && sync ? githubUrls(sync.githubWebUrl, source.repo) : null;
  const held = details.data;
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="medium"
      title={
        <span className="flex items-center gap-2.5">
          <GitPullRequestArrow className="size-5 text-amber-500" />
          <span>Review change from {label}</span>
        </span>
      }
      description={
        <span>
          {held?.sourceCommit && urls ? (
            <>
              <span>Commit </span>
              <a
                href={urls.commit(held.sourceCommit)}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-foreground underline-offset-4 hover:underline"
              >
                {held.sourceCommit.slice(0, 7)}
              </a>
              <span> in {source?.repo}. </span>
            </>
          ) : null}
          <span>Your current policy stays active until you approve.</span>
        </span>
      }
      bodyClassName="space-y-6"
      footer={
        <>
          <DialogCancelButton>Close</DialogCancelButton>
          <Button
            disabled={!mayApprove || !held || accept.isPending}
            onClick={() => accept.mutate(undefined, { onSuccess: onClose })}
          >
            Approve
          </Button>
        </>
      }
    >
      {details.isPending ? (
        <p className="text-sm text-muted-foreground">Loading the change…</p>
      ) : !held ? (
        <p className="text-sm text-muted-foreground">
          Nothing is waiting for approval anymore.
        </p>
      ) : (
        <HeldChanges held={held} />
      )}
      {!mayApprove && held && (
        <p className="text-xs text-muted-foreground">
          {held.reasons.includes("changes_credentials")
            ? "Approving takes permission to update guardrails, and Can use on every credential."
            : "Approving takes permission to update guardrails."}
        </p>
      )}
      <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          Want to reject it instead?
        </span>{" "}
        <span>
          The change lives in {label}, so undo it there. Once that syncs, this
          request goes away.
        </span>
        {source?.path && urls ? (
          <>
            {" "}
            <a
              href={urls.file(source.ref ?? "HEAD", source.path)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
            >
              <span>
                Edit {source.path} in {label}
              </span>
              <ExternalLink className="size-3" />
            </a>
          </>
        ) : null}
      </div>
    </StandardDialog>
  );
}

// ===================== Internals =====================

type HeldDetails = NonNullable<
  archestraApiTypes.GetHeldAppaGithubPullResponses["200"]
>;

function githubUrls(webUrl: string, repo: string) {
  const encode = (value: string) =>
    value.split("/").map(encodeURIComponent).join("/");
  return {
    commit: (sha: string) => `${webUrl}/${repo}/commit/${sha}`,
    file: (ref: string, path: string) =>
      `${webUrl}/${repo}/blob/${encode(ref)}/${encode(path)}`,
  };
}

function HeldChanges({ held }: { held: HeldDetails }) {
  const batteries = useBatteries();
  const catalog = useInternalMcpCatalog();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const credentials = useRuntimeCredentials(canReadCredentials === true);
  const summaryOf = (name: string) =>
    batteries.data?.find((battery) => battery.name === name) ?? null;
  const icon = (name: string) => {
    const summary = summaryOf(name);
    return (
      <BatteryIcon
        name={name}
        bundled={summary?.source === "bundled"}
        catalogIds={summary?.installs.map((install) => install.catalogId) ?? []}
        catalog={catalog.data ?? []}
      />
    );
  };
  return (
    <>
      {held.grants.length > 0 && (
        <DialogSection
          title="Credential access"
          description={
            <>
              <span>Approving lets each </span>
              <BatteryTerm />
              <span>
                {" "}
                use a saved credential, for example to call its service while it
                checks a tool call.
              </span>
            </>
          }
        >
          <ul className="divide-y rounded-md border">
            {held.grants.map((grant) => {
              const saved =
                credentials.data?.find((entry) => entry.key === grant.key) ??
                null;
              const missing = credentials.isSuccess && saved === null;
              return (
                <li
                  key={`${grant.battery}-${grant.variable}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-3 py-3"
                >
                  <BatteryCell
                    icon={icon(grant.battery)}
                    name={grant.battery}
                    description={summaryOf(grant.battery)?.description}
                  />
                  <ArrowRight className="size-4 text-muted-foreground" />
                  <div className="flex min-w-0 items-center gap-2.5">
                    <RuntimeCredentialIcon
                      icon={saved?.icon ?? null}
                      className="size-5 shrink-0"
                    />
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">
                          {saved?.name ?? grant.key}
                        </span>
                        {missing && <MissingCredential />}
                      </div>
                      <code className="block truncate font-mono text-[11px] leading-4 tracking-wide text-muted-foreground">
                        {grant.variable}
                      </code>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {held.grants.some(
            (grant) =>
              credentials.isSuccess &&
              !credentials.data.some((entry) => entry.key === grant.key),
          ) && (
            <p className="text-xs text-muted-foreground">
              <TriangleAlert className="mr-1 inline size-3.5 align-[-2px] text-amber-500" />
              <span>
                Some of these credentials aren't saved yet. The battery runs
                without them until someone adds them in{" "}
              </span>
              <SettingsLink
                href="/settings/credentials"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Settings &gt; Credentials
              </SettingsLink>
              <span>.</span>
            </p>
          )}
        </DialogSection>
      )}
      {held.droppedBatteries.length > 0 && (
        <DialogSection
          title="Batteries it removes"
          description="Added here, but missing from the repository's policy."
        >
          <ul className="divide-y rounded-md border">
            {held.droppedBatteries.map((name) => (
              <li key={name} className="px-3 py-3">
                <BatteryCell
                  icon={icon(name)}
                  name={name}
                  description={summaryOf(name)?.description}
                />
              </li>
            ))}
          </ul>
        </DialogSection>
      )}
    </>
  );
}

/** "battery", underlined, with what a battery is a hover away. */
function BatteryTerm() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-4">
          battery
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs space-y-1.5 py-2">
        <p>
          A battery is a ready-made set of guardrail rules for one tool or
          service, like the GitHub MCP server. Some call that service to check a
          tool call, which is what the credential is for.
        </p>
        <p className="flex gap-3 font-medium">
          <Link
            href="/openappa/batteries"
            className="underline underline-offset-4"
          >
            See batteries
          </Link>
          <a
            href={getDocsUrl(DocsPage.PlatformAiToolGuardrailsBatteries)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 underline underline-offset-4"
          >
            <span>Docs</span>
            <ExternalLink className="size-3" />
          </a>
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function MissingCredential() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label="Not saved yet"
          className="inline-flex shrink-0 text-amber-500"
        >
          <TriangleAlert className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Not saved yet. Add a credential with this key in Settings &gt;
        Credentials.
      </TooltipContent>
    </Tooltip>
  );
}

function BatteryCell({
  icon,
  name,
  description,
}: {
  icon: React.ReactNode;
  name: string;
  description: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{name}</div>
        {description && (
          <div className="truncate text-xs text-muted-foreground">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}
