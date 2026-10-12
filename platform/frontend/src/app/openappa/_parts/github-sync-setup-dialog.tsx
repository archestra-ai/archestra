"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ExternalLink,
  Github,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useAppaGithubAppAccounts,
  useCreateAppaGithubRepository,
  useDiscardAppaGithubApp,
  useInstallAppaGithubApp,
  usePendingAppaGithubApp,
  useStartAppaGithubApp,
} from "@/lib/openappa-github-sync.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import { cn } from "@/lib/utils/tailwind";
import { onGithubAppSetup } from "./github-app-channel";
import { OpenAppaSetupPullRequestDialog } from "./setup-pull-request-dialog";

/**
 * Sets up GitHub sync with the least access GitHub allows: the admin creates
 * the policy repository from the template on GitHub, then a GitHub App (an
 * existing one, or a new one GitHub registers from a manifest) is installed on
 * just that repository, and Archestra seeds the current policy into it.
 */
export function GithubSyncSetupDialog({
  onOpenChange,
  onConnectExisting,
}: {
  onOpenChange: (open: boolean) => void;
  onConnectExisting: () => void;
}) {
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const { data: canCreateCredentials } = useHasPermissions({
    credential: ["create"],
  });
  const credentials = useRuntimeCredentials(!!canReadCredentials);
  const apps =
    credentials.data?.filter(
      (credential) =>
        credential.allowOrganization &&
        credential.organizationConfigured &&
        credential.kind === "github_app",
    ) ?? [];
  const pending = usePendingAppaGithubApp(!!canCreateCredentials);
  const start = useStartAppaGithubApp();
  const install = useInstallAppaGithubApp();
  const discard = useDiscardAppaGithubApp();
  const create = useCreateAppaGithubRepository();

  const [step, setStep] = useState<Step>("repo");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("openappa-policy");
  const [openedTemplate, setOpenedTemplate] = useState(false);
  const [interval, setSyncInterval] = useState<Interval>("1h");
  const [editingInterval, setEditingInterval] = useState(false);
  const [chosenMode, setMode] = useState<AppMode | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  const [installed, setInstalled] = useState<{
    id: string;
    name: string;
    account: string;
  } | null>(null);
  const [pullRequest, setPullRequest] = useState<{
    repo: string;
    number: number;
  } | null>(null);

  const repo = `${owner.trim()}/${name.trim()}`;
  const repoValid = REPO_PATTERN.test(repo);
  const accounts = useAppaGithubAppAccounts({
    enabled: step !== "repo" && !!canReadCredentials && apps.length > 0,
    repo,
  });
  const reaches = (id: string) =>
    accounts.data?.find((entry) => entry.id === id)?.canAccessRepo === true;
  const reachable = apps.filter((app) => reaches(app.id));
  const createdApp = pending.data ?? null;
  // An App created earlier still awaits installation: pick up where setup stopped.
  const mode: AppMode =
    chosenMode ?? (createdApp || !apps.length ? "create" : "fork");
  const appId =
    mode === "pick" ? (reaches(pickedId) ? pickedId : null) : installed?.id;

  // Resume a setup whose App exists: its account owns the repository.
  useEffect(() => {
    if (createdApp) setOwner((current) => current || createdApp.account);
  }, [createdApp]);

  // The callback tab reports back once GitHub finishes each step.
  const onSetupStep = useRef<(done: "created" | "installed") => void>(() => {});
  onSetupStep.current = (done) => {
    if (done === "installed") return checkInstall();
    setWaiting(null);
    pending.refetch();
  };
  useEffect(() => onGithubAppSetup((done) => onSetupStep.current(done)), []);

  function openTemplate() {
    const url = new URL("https://github.com/new");
    url.searchParams.set("template_owner", TEMPLATE.owner);
    url.searchParams.set("template_name", TEMPLATE.name);
    url.searchParams.set("owner", owner.trim());
    url.searchParams.set("name", name.trim());
    url.searchParams.set("visibility", "private");
    window.open(url, "_blank", "noopener");
    setOpenedTemplate(true);
  }

  function createApp() {
    // Open the tab inside the click so the browser does not block it.
    const tab = openGithubWindow("about:blank");
    setWaiting("create");
    start.mutate(
      { owner: owner.trim() },
      {
        onSuccess: (manifest) => {
          if (manifest) postManifest(manifest);
          else tab?.close();
        },
        onError: () => {
          tab?.close();
          setWaiting(null);
        },
      },
    );
  }

  function installApp() {
    if (!createdApp) return;
    install.reset();
    openGithubWindow(createdApp.installUrl);
    setWaiting("install");
  }

  function checkInstall() {
    install.mutate(
      { repo },
      {
        onSuccess: (result) => {
          if (result?.status !== "installed") return;
          setInstalled(result);
          setWaiting(null);
        },
        onError: () => setWaiting(null),
      },
    );
  }

  function connect() {
    if (!appId) return;
    setStep("connect");
    create.mutate(
      {
        owner: owner.trim(),
        name: name.trim(),
        githubAppConfigId: appId,
        interval,
        existing: true,
      },
      {
        onSuccess: (data) => {
          const number = data?.source?.setupPullRequestNumber;
          if (number && data.source?.repo)
            setPullRequest({ repo: data.source.repo, number });
          else onOpenChange(false);
        },
        onError: () => setStep("app"),
      },
    );
  }

  if (pullRequest)
    return (
      <OpenAppaSetupPullRequestDialog
        pullRequest={pullRequest}
        onOpenChange={onOpenChange}
      />
    );

  const header = headerFor({ step, mode, repo });
  const loadingApps =
    credentials.isPending || (!!canCreateCredentials && pending.isPending);

  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title={header.title}
      description={header.description}
      size="medium"
      bodyClassName="space-y-5"
      footer={
        <>
          {step === "app" ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() =>
                mode !== "fork" && apps.length > 0 && !createdApp
                  ? setMode("fork")
                  : setStep("repo")
              }
            >
              <ArrowLeft />
              <span>Back</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={step === "connect"}
            onClick={() => onOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          {step === "repo" ? (
            <Button
              type="button"
              disabled={!repoValid}
              onClick={() => setStep("app")}
            >
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "app" && mode !== "fork" ? (
            <Button type="button" disabled={!appId} onClick={connect}>
              <span>Connect repository</span>
            </Button>
          ) : null}
        </>
      }
    >
      <Stepper step={step} />

      {step === "repo" ? (
        <div className="space-y-5">
          <div className="space-y-2">
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] items-end gap-x-2 gap-y-2">
              <Label htmlFor="github-sync-owner">Owner</Label>
              <span />
              <Label htmlFor="github-sync-name">Repository name</Label>
              <Input
                id="github-sync-owner"
                value={owner}
                placeholder="your-org"
                autoComplete="off"
                data-1p-ignore
                spellCheck={false}
                onChange={(event) => setOwner(event.target.value)}
              />
              <span className="pb-2 text-muted-foreground">/</span>
              <Input
                id="github-sync-name"
                value={name}
                autoComplete="off"
                data-1p-ignore
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-4 rounded-lg border bg-card p-4">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium">
                Create it from the OpenAPPA template
              </p>
              <p className="text-xs text-muted-foreground">
                {openedTemplate
                  ? "Finish on GitHub, keep it private, then continue here."
                  : "GitHub opens with the template, owner and name filled in. Keep it private."}
              </p>
            </div>
            <GitHubConnectButton
              label="Create on GitHub"
              disabled={!repoValid}
              onClick={openTemplate}
            />
          </div>

          <div className="flex min-h-8 flex-wrap items-center gap-2 text-sm">
            <RefreshCw className="size-3.5 text-muted-foreground" />
            {editingInterval ? (
              <>
                <span className="text-muted-foreground">Check GitHub</span>
                <Select
                  value={interval}
                  onValueChange={(value) => setSyncInterval(value as Interval)}
                >
                  <SelectTrigger size="sm" aria-label="Sync interval">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {INTERVAL_LABEL[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">
                  Checks GitHub for changes {INTERVAL_LABEL[interval]}.
                </span>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto px-0"
                  onClick={() => setEditingInterval(true)}
                >
                  <span>Change</span>
                </Button>
              </>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-2 border-t pt-4 text-sm">
            <span className="text-muted-foreground">
              Already have a repository with a policy in it?
            </span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={onConnectExisting}
            >
              <span>Connect it instead</span>
            </Button>
          </div>
        </div>
      ) : null}

      {step === "app" && loadingApps ? (
        <div className="flex h-24 items-center justify-center">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {step === "app" && !loadingApps && mode === "fork" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ForkCard
            onClick={() => {
              setMode("pick");
              if (!pickedId && reachable.length === 1)
                setPickedId(reachable[0].id);
            }}
            visual={<AppIconStack icons={apps.map((app) => app.icon)} />}
            title="Use an App I already have"
            body={
              accounts.isPending
                ? "Checking which can reach the repository…"
                : reachable.length
                  ? `${reachable.length} of ${apps.length} can reach ${repo}.`
                  : `None can reach ${repo} yet.`
            }
          />
          <ForkCard
            onClick={() => setMode("create")}
            disabled={!canCreateCredentials}
            visual={
              <span className="flex size-9 items-center justify-center rounded-lg border border-dashed">
                <Plus className="size-4 text-muted-foreground" />
              </span>
            }
            title="Create a new GitHub App"
            body={
              canCreateCredentials
                ? "A few clicks on GitHub. No keys to copy."
                : "Requires permission to create credentials."
            }
          />
        </div>
      ) : null}

      {step === "app" && !loadingApps && mode === "pick" ? (
        <div className="space-y-4">
          <RadioGroup
            value={pickedId}
            onValueChange={setPickedId}
            className="gap-2"
            aria-label="GitHub App"
          >
            {apps.map((app) => {
              const account = accounts.data?.find(
                (entry) => entry.id === app.id,
              );
              const blocked = !accounts.isPending && !reaches(app.id);
              return (
                <Label
                  key={app.id}
                  htmlFor={`github-sync-app-${app.id}`}
                  className={cn(
                    radioCardClass(),
                    "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-normal",
                    blocked && "cursor-not-allowed opacity-60",
                  )}
                >
                  <RadioGroupItem
                    value={app.id}
                    id={`github-sync-app-${app.id}`}
                    disabled={blocked}
                  />
                  <RuntimeCredentialIcon
                    icon={app.icon ?? "logo:github"}
                    className="size-4"
                    size={16}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {app.name}
                  </span>
                  {accounts.isPending ? (
                    <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
                  ) : blocked ? (
                    <span className="text-xs text-muted-foreground">
                      No access to {repo}
                    </span>
                  ) : account?.account ? (
                    <AccountChip account={account.account} />
                  ) : null}
                </Label>
              );
            })}
          </RadioGroup>
          <AccessSummary repo={repo} />
        </div>
      ) : null}

      {step === "app" && !loadingApps && mode === "create" ? (
        canCreateCredentials ? (
          <div className="space-y-4">
            <ol className="overflow-hidden rounded-lg border bg-card">
              <ManifestRow
                index={1}
                title="Create the App on GitHub"
                hint={`GitHub registers it on ${owner.trim()}, with the access below.`}
                inlineAction
                waiting={waiting === "create"}
                error={start.error?.message}
                onCheckAgain={() => {
                  setWaiting(null);
                  pending.refetch();
                }}
                result={
                  createdApp ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        Created
                      </span>
                      <a
                        className="truncate text-sm font-medium underline-offset-4 hover:underline"
                        href={createdApp.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {createdApp.name}
                      </a>
                      {installed ? null : (
                        <Button
                          type="button"
                          variant="link"
                          size="xs"
                          className="h-auto px-0 text-muted-foreground"
                          disabled={discard.isPending}
                          onClick={() =>
                            discard.mutate(undefined, {
                              onSuccess: () => setWaiting(null),
                            })
                          }
                        >
                          <span>Start over</span>
                        </Button>
                      )}
                    </>
                  ) : null
                }
                action={
                  <GitHubConnectButton
                    label="Create App on GitHub"
                    pending={start.isPending}
                    onClick={createApp}
                  />
                }
              />
              <ManifestRow
                index={2}
                title={`Install it on ${repo}`}
                hint={`On GitHub, choose Only select repositories, then ${name.trim()}.`}
                locked={!createdApp}
                inlineAction
                waiting={waiting === "install" || install.isPending}
                error={install.error?.message}
                onCheckAgain={checkInstall}
                result={
                  installed ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        Installed on
                      </span>
                      <AccountChip account={repo} />
                    </>
                  ) : null
                }
                action={
                  <GitHubConnectButton
                    label="Install on GitHub"
                    disabled={!createdApp}
                    onClick={installApp}
                  />
                }
              />
            </ol>
            {createdApp ? (
              <AppLogoTip settingsUrl={createdApp.settingsUrl} />
            ) : null}
            <AccessSummary repo={repo} />
          </div>
        ) : (
          <InlineNotice variant="info">
            <InlineNoticeText>
              Ask an administrator who can create credentials to set up the
              GitHub App.
            </InlineNoticeText>
          </InlineNotice>
        )
      ) : null}

      {step === "connect" ? (
        <ul
          className="space-y-3 rounded-lg border bg-card p-4"
          aria-live="polite"
        >
          {CONNECT_STEPS.map((label, index) => (
            <li key={label} className="flex items-center gap-3 text-sm">
              {index === 0 ? (
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <span className="flex size-4 items-center justify-center">
                  <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                </span>
              )}
              <span className={cn(index > 0 && "text-muted-foreground")}>
                {label}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {step === "app" && create.error ? (
        <InlineNotice variant="error">
          <AlertTriangle aria-hidden />
          <span className="font-medium">Couldn't connect {repo}</span>
          <InlineNoticeText className="basis-full pl-5">
            {create.error.message}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
    </StandardDialog>
  );
}

// ===================== Internals =====================

type Step = "repo" | "app" | "connect";
type AppMode = "fork" | "pick" | "create";
type Interval = "15m" | "1h" | "1d";

function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((entry) => entry.id === step);
  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Setup progress">
      {STEPS.map((entry, index) => {
        const complete = index < current;
        const active = index === current;
        return (
          <li
            key={entry.id}
            aria-current={active ? "step" : undefined}
            className="space-y-1.5"
          >
            <span
              className={cn(
                "block h-0.5 rounded-full transition-colors duration-300",
                complete || active ? "bg-primary" : "bg-border",
              )}
            />
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs",
                active
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {complete ? (
                <Check className="size-3 text-primary" />
              ) : (
                <span className="tabular-nums">{index + 1}</span>
              )}
              <span>{entry.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ForkCard({
  onClick,
  disabled = false,
  visual,
  title,
  body,
}: {
  onClick: () => void;
  disabled?: boolean;
  visual: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={disabled}
      className={cn(
        radioCardClass(),
        "group flex flex-col items-start gap-6 rounded-lg p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {visual}
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </UnstyledButton>
  );
}

function AppIconStack({ icons }: { icons: (string | null)[] }) {
  return (
    <span className="flex -space-x-2">
      {icons.slice(0, 3).map((icon, index) => (
        <span
          // Icons repeat and never reorder.
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative stack
          key={index}
          className="flex size-9 items-center justify-center rounded-lg border bg-background"
        >
          <RuntimeCredentialIcon
            icon={icon ?? "logo:github"}
            className="size-4"
            size={16}
          />
        </span>
      ))}
    </span>
  );
}

function ManifestRow({
  index,
  title,
  hint,
  waiting,
  locked = false,
  onCheckAgain,
  result,
  action,
  inlineAction = false,
  error,
}: {
  index: number;
  title: string;
  hint: string;
  /**
   * Replaces the hint while this step's last attempt failed. A step with an
   * inline action (install) also offers to check GitHub again beside it.
   */
  error?: string;
  waiting: boolean;
  locked?: boolean;
  onCheckAgain: () => void;
  result: React.ReactNode;
  action: React.ReactNode;
  /** Short actions sit beside the text; wide ones (a form) go underneath. */
  inlineAction?: boolean;
}) {
  const done = !!result;
  const showAction = !(done || waiting || locked);
  return (
    <li
      className={cn(
        "flex items-start gap-3 border-b p-4 last:border-b-0 transition-opacity",
        locked && "opacity-60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums transition-colors",
          done &&
            "border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-950/50 dark:text-emerald-400",
        )}
      >
        {done ? <Check className="size-3.5" /> : <span>{index}</span>}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {done ? (
          <div className="flex flex-wrap items-center gap-2 animate-in fade-in duration-300">
            {result}
          </div>
        ) : waiting ? (
          <p
            className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <LoaderCircle className="size-3.5 animate-spin" />
            <span>Finish in the GitHub tab that opened.</span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={onCheckAgain}
            >
              <span>Done? Check again</span>
            </Button>
          </p>
        ) : error ? (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{error}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {showAction && !inlineAction ? (
          <div className="pt-2">{action}</div>
        ) : null}
      </div>
      {showAction && inlineAction ? (
        <div className="flex shrink-0 items-center gap-2 self-center">
          {error ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onCheckAgain}
            >
              <span>Check again</span>
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </li>
  );
}

// GitHub's manifest cannot set a logo, so the admin uploads it on the App's page.
function AppLogoTip({ settingsUrl }: { settingsUrl: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>Optional: give the App the OpenAPPA logo.</span>
      <a
        className="font-medium text-foreground underline-offset-4 hover:underline"
        href={APP_LOGO_PATH}
        download="openappa-github-app-logo.png"
      >
        Download logo
      </a>
      <a
        className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
        href={settingsUrl}
        target="_blank"
        rel="noreferrer"
      >
        Open App settings
        <ExternalLink className="size-3" />
      </a>
    </p>
  );
}

function AccessSummary({ repo }: { repo: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          The App only needs <span className="font-mono">{repo}</span>, nothing
          else in the organization:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {["Contents", "Pull requests"].map((permission) => (
            <Badge key={permission} variant="outline" className="bg-background">
              <span>{permission}</span>
              <span className="font-normal text-muted-foreground">
                Read &amp; write
              </span>
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}

function AccountChip({ account }: { account: string }) {
  return (
    <Badge variant="outline" className="bg-background font-mono font-normal">
      <Github />
      <span>{account}</span>
    </Badge>
  );
}

function headerFor(params: { step: Step; mode: AppMode; repo: string }) {
  if (params.step === "repo")
    return {
      title: "Set up GitHub sync",
      description:
        "Your policy will live in a private GitHub repository that you create. Archestra only ever gets access to that repository.",
    };
  if (params.step === "app") {
    if (params.mode === "fork")
      return {
        title: "Connect a GitHub App",
        description: `Archestra reads and proposes policy changes in ${params.repo} through a GitHub App.`,
      };
    if (params.mode === "pick")
      return {
        title: "Choose a GitHub App",
        description: `Only Apps installed on ${params.repo} can be used.`,
      };
    return {
      title: "Create a GitHub App",
      description: "GitHub creates the App for you. No IDs or keys to copy.",
    };
  }
  return {
    title: "Connecting the repository",
    description: "This takes a few seconds.",
  };
}

function openGithubWindow(url: string) {
  // A named tab, so the manifest post and the install land in the same one.
  return window.open(url, GITHUB_WINDOW);
}

/** GitHub only accepts a manifest as a form post, so post one into the window. */
function postManifest(params: { url: string; manifest: string }) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = params.url;
  form.target = GITHUB_WINDOW;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = params.manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

const GITHUB_WINDOW = "openappa-github-app";

const STEPS: { id: Step; label: string }[] = [
  { id: "repo", label: "Repository" },
  { id: "app", label: "GitHub App" },
  { id: "connect", label: "Connect" },
];

const CONNECT_STEPS = [
  "Check the repository",
  "Copy your current policy",
  "Open the setup pull request if rules require one",
];

const TEMPLATE = { owner: "archestra-ai", name: "openappa-config" };

const INTERVALS: Interval[] = ["15m", "1h", "1d"];
const INTERVAL_LABEL: Record<Interval, string> = {
  "15m": "every 15 minutes",
  "1h": "every hour",
  "1d": "once a day",
};

const REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const APP_LOGO_PATH = "/openappa/github-app-logo.png";
