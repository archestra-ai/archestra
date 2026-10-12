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
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
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
 * Sets up GitHub sync in three steps: a GitHub App (an existing one, or a new
 * one GitHub creates from a manifest so nothing is copied by hand), the
 * repository to create, and the setup pull request when repository rules ask
 * for one.
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
  const accounts = useAppaGithubAppAccounts(
    !!canReadCredentials && apps.length > 0,
  );
  const pending = usePendingAppaGithubApp(!!canCreateCredentials);
  const start = useStartAppaGithubApp();
  const install = useInstallAppaGithubApp();
  const discard = useDiscardAppaGithubApp();
  const create = useCreateAppaGithubRepository();

  const [step, setStep] = useState<Step>("app");
  const [chosenMode, setMode] = useState<AppMode | null>(null);
  const [pickedId, setPickedId] = useState("");
  const [organization, setOrganization] = useState("");
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  const [installed, setInstalled] = useState<{
    id: string;
    name: string;
    account: string;
  } | null>(null);
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("openappa-policy");
  const [interval, setSyncInterval] = useState<Interval>("1h");
  const [editingInterval, setEditingInterval] = useState(false);
  const [pullRequest, setPullRequest] = useState<{
    repo: string;
    number: number;
  } | null>(null);

  const createdApp = pending.data ?? null;
  // An App created earlier still awaits installation: pick up where setup stopped.
  const mode: AppMode =
    chosenMode ?? (createdApp || !apps.length ? "create" : "fork");
  const accountFor = (id: string) =>
    accounts.data?.find((entry) => entry.id === id)?.account ?? null;
  const picked = apps.find((app) => app.id === pickedId);
  const appId = mode === "pick" ? picked?.id : installed?.id;
  const repo = `${owner.trim()}/${name.trim()}`;
  const loading =
    credentials.isPending || (!!canCreateCredentials && pending.isPending);

  // The callback window reports back once GitHub finishes each step.
  const onSetupStep = useRef<(done: "created" | "installed") => void>(() => {});
  onSetupStep.current = (done) => {
    if (done === "installed") return checkInstall();
    setWaiting(null);
    pending.refetch();
  };
  useEffect(() => onGithubAppSetup((done) => onSetupStep.current(done)), []);

  function createApp() {
    // Open the window inside the click so the browser does not block it.
    const popup = openGithubWindow("about:blank");
    setWaiting("create");
    start.mutate(
      { organization: organization.trim() },
      {
        onSuccess: (manifest) => {
          if (manifest) postManifest(manifest);
          else popup?.close();
        },
        onError: () => {
          popup?.close();
          setWaiting(null);
        },
      },
    );
  }

  function installApp() {
    if (!createdApp) return;
    openGithubWindow(createdApp.installUrl);
    setWaiting("install");
  }

  function checkInstall() {
    install.mutate(undefined, {
      onSuccess: (result) => {
        if (result?.status !== "installed") return;
        setInstalled(result);
        setWaiting(null);
      },
      onError: () => setWaiting(null),
    });
  }

  function goToRepo() {
    setOwner(
      (mode === "pick" ? accountFor(pickedId) : installed?.account) ?? "",
    );
    setStep("repo");
  }

  function createRepository() {
    if (!appId) return;
    setStep("create");
    create.mutate(
      {
        owner: owner.trim(),
        name: name.trim(),
        githubAppConfigId: appId,
        interval,
      },
      {
        onSuccess: (data) => {
          const number = data?.source?.setupPullRequestNumber;
          if (number && data.source?.repo)
            setPullRequest({ repo: data.source.repo, number });
          else onOpenChange(false);
        },
        onError: () => setStep("repo"),
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

  const header = headerFor({ step, mode, hasApps: apps.length > 0 });
  const appReady = !!appId;
  const error =
    step === "app"
      ? (start.error ?? install.error)
      : step === "repo"
        ? create.error
        : null;

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
          {step === "app" && mode !== "fork" && apps.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => setMode("fork")}
            >
              <ArrowLeft />
              <span>Back</span>
            </Button>
          ) : null}
          {step === "repo" ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => setStep("app")}
            >
              <ArrowLeft />
              <span>Back</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={step === "create"}
            onClick={() => onOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          {step === "app" && mode !== "fork" ? (
            <Button type="button" disabled={!appReady} onClick={goToRepo}>
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "repo" ? (
            <Button
              type="button"
              disabled={!REPO_PATTERN.test(repo)}
              onClick={createRepository}
            >
              <span>Create repository</span>
            </Button>
          ) : null}
        </>
      }
    >
      <Stepper step={step} />

      {step === "app" && loading ? (
        <div className="flex h-24 items-center justify-center">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {step === "app" && !loading && mode === "fork" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ForkCard
            onClick={() => {
              setMode("pick");
              if (!pickedId && apps.length === 1) setPickedId(apps[0].id);
            }}
            visual={<AppIconStack icons={apps.map((app) => app.icon)} />}
            title="Use an App I already have"
            body={
              apps.length === 1
                ? "1 GitHub App is connected."
                : `${apps.length} GitHub Apps are connected.`
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

      {step === "app" && !loading && mode === "pick" ? (
        <div className="space-y-4">
          <RadioGroup
            value={pickedId}
            onValueChange={setPickedId}
            className="gap-2"
            aria-label="GitHub App"
          >
            {apps.map((app) => (
              <Label
                key={app.id}
                htmlFor={`github-sync-app-${app.id}`}
                className={cn(
                  radioCardClass(),
                  "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 font-normal",
                )}
              >
                <RadioGroupItem
                  value={app.id}
                  id={`github-sync-app-${app.id}`}
                />
                <RuntimeCredentialIcon
                  icon={app.icon ?? "logo:github"}
                  className="size-4"
                  size={16}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {app.name}
                </span>
                {accountFor(app.id) ? (
                  <AccountChip account={accountFor(app.id) as string} />
                ) : null}
              </Label>
            ))}
          </RadioGroup>
          <AccessSummary compact />
        </div>
      ) : null}

      {step === "app" && !loading && mode === "create" ? (
        canCreateCredentials ? (
          <div className="space-y-4">
            <ol className="overflow-hidden rounded-lg border bg-card">
              <ManifestRow
                index={1}
                title="Create the App on GitHub"
                hint="Enter the organization that will own the policy repository. GitHub creates the App there with the access below."
                waiting={waiting === "create"}
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
                  <form
                    className="flex flex-col gap-2 sm:flex-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      createApp();
                    }}
                  >
                    <InputGroup className="sm:flex-1">
                      <InputGroupAddon>
                        <span>github.com/</span>
                      </InputGroupAddon>
                      <InputGroupInput
                        id="github-sync-organization"
                        aria-label="GitHub organization"
                        placeholder="your-organization"
                        autoComplete="off"
                        data-1p-ignore
                        spellCheck={false}
                        value={organization}
                        onChange={(event) =>
                          setOrganization(event.target.value)
                        }
                      />
                    </InputGroup>
                    <Button
                      type="submit"
                      disabled={
                        !ORGANIZATION_PATTERN.test(organization.trim()) ||
                        start.isPending
                      }
                    >
                      <Github />
                      <span>Create App on GitHub</span>
                    </Button>
                  </form>
                }
              />
              <ManifestRow
                index={2}
                title="Install it on the organization"
                hint="Approve access to all of its repositories."
                locked={!createdApp}
                inlineAction
                waiting={waiting === "install" || install.isPending}
                onCheckAgain={checkInstall}
                result={
                  installed ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        Installed on
                      </span>
                      <AccountChip account={installed.account} />
                      <span className="text-xs text-muted-foreground">
                        All repositories
                      </span>
                    </>
                  ) : null
                }
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant={createdApp ? "default" : "outline"}
                    disabled={!createdApp}
                    onClick={installApp}
                  >
                    <span>Install on GitHub</span>
                  </Button>
                }
              />
            </ol>
            {createdApp ? <AppLogoTip app={createdApp} /> : null}
            <AccessSummary />
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

      {step === "repo" ? (
        <div className="space-y-5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.4fr)] items-end gap-x-2 gap-y-2">
            <Label htmlFor="github-sync-owner">Owner</Label>
            <span />
            <Label htmlFor="github-sync-name">Repository name</Label>
            <Input
              id="github-sync-owner"
              value={owner}
              placeholder="your-org"
              onChange={(event) => setOwner(event.target.value)}
            />
            <span className="pb-2 text-muted-foreground">/</span>
            <Input
              id="github-sync-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="col-span-3 text-xs text-muted-foreground">
              A new private repository on the organization where the App is
              installed.
            </p>
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
              Already have a policy repository?
            </span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-0"
              onClick={onConnectExisting}
            >
              <span>Use an existing repository instead</span>
            </Button>
          </div>
        </div>
      ) : null}

      {step === "create" ? (
        <ul
          className="space-y-3 rounded-lg border bg-card p-4"
          aria-live="polite"
        >
          {CREATE_STEPS.map((label, index) => (
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

      {error ? (
        <InlineNotice variant="error">
          <AlertTriangle aria-hidden />
          <span className="font-medium">
            {step === "repo"
              ? "Couldn't create the repository"
              : "GitHub App setup didn't finish"}
          </span>
          <InlineNoticeText className="basis-full pl-5">
            {error.message}
          </InlineNoticeText>
        </InlineNotice>
      ) : null}
    </StandardDialog>
  );
}

// ===================== Internals =====================

type Step = "app" | "repo" | "create";
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
}: {
  index: number;
  title: string;
  hint: string;
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
        ) : (
          <p className="text-xs text-muted-foreground">{hint}</p>
        )}
        {showAction && !inlineAction ? (
          <div className="pt-2">{action}</div>
        ) : null}
      </div>
      {showAction && inlineAction ? (
        <div className="shrink-0 self-center">{action}</div>
      ) : null}
    </li>
  );
}

// GitHub's manifest cannot set a logo, so the admin uploads it on the App's page.
function AppLogoTip({ app }: { app: { slug: string; account: string } }) {
  const [copied, setCopied] = useState(false);
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
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto px-0 text-foreground"
        onClick={() => {
          navigator.clipboard
            .writeText(APP_BADGE_COLOR)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied ? "Copied" : `Copy badge color ${APP_BADGE_COLOR}`}
      </Button>
      <a
        className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
        href={`https://github.com/organizations/${app.account}/settings/apps/${app.slug}`}
        target="_blank"
        rel="noreferrer"
      >
        Open App settings
        <ExternalLink className="size-3" />
      </a>
    </p>
  );
}

function AccessSummary({ compact = false }: { compact?: boolean }) {
  if (compact)
    return (
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-px size-3.5 shrink-0" />
        <span>
          The App needs Administration, Contents and Pull requests set to Read
          &amp; write, on all repositories of the organization it is installed
          on.
        </span>
      </p>
    );
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          GitHub will ask you to approve this access on all repositories of the
          organization:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {["Administration", "Contents", "Pull requests"].map((permission) => (
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

function headerFor(params: { step: Step; mode: AppMode; hasApps: boolean }) {
  if (params.step === "app") {
    if (params.mode === "fork")
      return {
        title: "Set up GitHub sync",
        description:
          "Your policy will live in a GitHub repository. First, pick the GitHub App that connects to it.",
      };
    if (params.mode === "pick")
      return {
        title: "Choose a GitHub App",
        description: "It creates the repository and reads changes.",
      };
    return {
      title: params.hasApps ? "Create a GitHub App" : "Set up GitHub sync",
      description: params.hasApps
        ? "GitHub creates the App for you. No IDs or keys to copy."
        : "Your policy will live in a GitHub repository. First, create the GitHub App that connects to it. No IDs or keys to copy.",
    };
  }
  if (params.step === "repo")
    return {
      title: "Name the repository",
      description: "We create it and copy your current policy into it.",
    };
  return {
    title: "Creating repository",
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
  { id: "app", label: "GitHub App" },
  { id: "repo", label: "Repository" },
  { id: "create", label: "Create" },
];

const CREATE_STEPS = [
  "Create the private repository",
  "Copy your current policy",
  "Open the setup pull request if rules require one",
];

const INTERVALS: Interval[] = ["15m", "1h", "1d"];
const INTERVAL_LABEL: Record<Interval, string> = {
  "15m": "every 15 minutes",
  "1h": "every hour",
  "1d": "once a day",
};

const REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/;
const APP_LOGO_PATH = "/openappa/github-app-logo.png";
const APP_BADGE_COLOR = "#161413";
const ORGANIZATION_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
