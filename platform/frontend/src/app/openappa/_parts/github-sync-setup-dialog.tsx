"use client";

import {
  DocsPage,
  type GitProvider,
  getGithubApiBaseUrl,
  gitChangeRequestNoun,
} from "@archestra/shared";
import {
  AlertTriangle,
  ArrowLeft,
  BookMarked,
  Check,
  ChevronRight,
  ExternalLink,
  Github,
  LoaderCircle,
  Lock,
  Plus,
  ShieldCheck,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { GitAccessStep } from "@/components/git/git-access-step";
import { GitProviderStep } from "@/components/git/git-provider-step";
import {
  ChoiceTile,
  GitProviderLogo,
  SetupStepper,
} from "@/components/git/git-setup-chrome";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { RuntimeCredentialIcon } from "@/components/runtime-credential-icon";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
  radioCardClass,
} from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import {
  useGitCredentialNamespaces,
  useGitCredentials,
} from "@/lib/git-credentials.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import {
  useAppaGithubAppAccounts,
  useAppaGithubAppRepositories,
  useAppaGithubRepositoryStatus,
  useConfigureAppaGithubSync,
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
 * Sets up Git sync for the policy. The admin first picks GitHub or GitLab.
 *
 * GitHub gets the least access GitHub allows: the admin starts a policy
 * repository (or uses one they have) on github.com or GitHub Enterprise
 * Server, creates a GitHub App on the organization that owns it, installs the
 * App on just that repository, and picks the repository from what it can see.
 *
 * GitLab (cloud or self-managed) uses a saved token: the admin picks or adds
 * one, then creates a private project in a group the token can reach, or
 * picks an existing project.
 */
export function GithubSyncSetupDialog({
  onOpenChange,
  editing,
}: {
  onOpenChange: (open: boolean) => void;
  /** An App-backed source to change: the flow opens on its repository, filled in. */
  editing?: EditedSource;
}) {
  const appName = useAppName();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const { data: canCreateCredentials } = useHasPermissions({
    credential: ["create"],
  });
  const credentials = useRuntimeCredentials(!!canReadCredentials);
  const [provider, setProvider] = useState<GitProvider | null>(
    editing?.provider ?? null,
  );
  const gitlab = provider === "gitlab";
  const [githubUrl, setGithubUrl] = useState(
    editing?.provider === "github" ? editing.webUrl : DOT_COM_WEB,
  );
  const github = parseGithubUrl(githubUrl);
  const [ownerInput, setOwnerInput] = useState(
    editing?.repo.split("/")[0] ?? "",
  );
  const owner = ownerFromInput(ownerInput);
  const ready = !!github && OWNER_PATTERN.test(owner);
  // An App lives on one GitHub; only those on the same one can serve it.
  const apps =
    credentials.data?.filter(
      (credential) =>
        credential.allowOrganization &&
        credential.organizationConfigured &&
        credential.kind === "github_app" &&
        (!github ||
          (credential.githubUrl ?? DOT_COM_API).replace(/\/+$/, "") ===
            github.api),
    ) ?? [];
  const pending = usePendingAppaGithubApp(!!canCreateCredentials);
  const start = useStartAppaGithubApp();
  const install = useInstallAppaGithubApp();
  const discard = useDiscardAppaGithubApp();
  const create = useCreateAppaGithubRepository();
  const configure = useConfigureAppaGithubSync();

  const [step, setStep] = useState<Step>(editing ? "repo" : "provider");
  const [origin, setOrigin] = useState<Origin | null>(
    editing ? "existing" : null,
  );
  const [openedTemplate, setOpenedTemplate] = useState(false);
  const [chosenMode, setMode] = useState<AppMode | null>(
    editing ? "pick" : null,
  );
  const [pickedId, setPickedId] = useState(
    editing?.provider === "github" ? editing.credentialId : "",
  );
  // GitLab: the saved token, then a new project in a group or an existing one.
  const [gitlabTokenId, setGitlabTokenId] = useState(
    editing?.provider === "gitlab" ? editing.credentialId : "",
  );
  const gitCredentials = useGitCredentials(!!canReadCredentials && gitlab);
  const gitlabToken =
    gitCredentials.data?.find((entry) => entry.id === gitlabTokenId) ?? null;
  const [projectMode, setProjectMode] = useState<"create" | "existing">(
    editing ? "existing" : "create",
  );
  const namespaces = useGitCredentialNamespaces(
    gitlab && step === "repo" && projectMode === "create"
      ? gitlabTokenId || null
      : null,
  );
  const [group, setGroup] = useState<string | null>(null);
  const chosenGroup = group ?? namespaces.data?.[1] ?? namespaces.data?.[0];
  const [projectName, setProjectName] = useState(FRESH_NAME);
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  const [installed, setInstalled] = useState<{
    id: string;
    name: string;
    account: string;
  } | null>(null);
  const [chosenRepo, setRepo] = useState(editing?.repo ?? "");
  const [advanced, setAdvanced] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [ref, setRef] = useState(editing?.ref ?? "");
  const [path, setPath] = useState(editing?.path ?? "appa.toml");
  const [validations, setValidations] = useState(
    editing?.validationDirectory || DEFAULT_VALIDATIONS,
  );
  const [interval, setSyncInterval] = useState<SyncInterval>(
    editing?.interval ?? DEFAULT_INTERVAL,
  );
  const [pullRequest, setPullRequest] = useState<{
    repo: string;
    number: number;
  } | null>(null);

  const accounts = useAppaGithubAppAccounts(
    (step === "app" || step === "repo") &&
      !gitlab &&
      !!canReadCredentials &&
      apps.length > 0,
  );
  const createdApp = pending.data ?? null;
  // An App created earlier still awaits installation: pick up where setup stopped.
  const mode: AppMode =
    chosenMode ?? (createdApp || !apps.length ? "create" : "fork");
  const appId = gitlab
    ? gitlabTokenId || null
    : mode === "pick"
      ? pickedId || null
      : (installed?.id ?? null);
  const creatingProject = gitlab && projectMode === "create";
  const appLabel =
    mode === "pick"
      ? apps.find((app) => app.id === pickedId)?.name
      : installed?.name;
  const repositories = useAppaGithubAppRepositories(
    step === "repo" && !creatingProject ? appId : null,
  );
  // A fresh setup just created the repository; offer it without a search.
  const repo =
    chosenRepo ||
    (origin === "fresh"
      ? (repositories.data?.repositories.find(
          (entry) =>
            entry.template ||
            entry.fullName.toLowerCase().endsWith(`/${FRESH_NAME}`),
        )?.fullName ?? "")
      : "");
  const location = {
    ref: ref.trim() || undefined,
    path: path.trim() && path.trim() !== "appa.toml" ? path.trim() : undefined,
    validationDirectory:
      validations.trim().replace(/\/+$/, "") &&
      validations.trim().replace(/\/+$/, "") !== DEFAULT_VALIDATIONS
        ? validations.trim().replace(/\/+$/, "")
        : undefined,
  };
  const locationValid =
    (!location.path || POLICY_PATH.test(location.path)) &&
    (!location.validationDirectory ||
      DIRECTORY_PATH.test(location.validationDirectory));
  const validationFolder = location.validationDirectory ?? DEFAULT_VALIDATIONS;
  const lookupKey =
    repo && locationValid ? JSON.stringify([repo, location]) : null;
  const checked = useDebouncedValue(lookupKey, 400);
  const repoLookup = useAppaGithubRepositoryStatus(
    step === "repo" && !creatingProject && appId && checked && lookupKey
      ? { credentialId: appId, repo, ...location }
      : null,
  );
  const lookedUp: RepositoryStatus =
    checked !== lookupKey || repoLookup.isPending
      ? "checking"
      : repoLookup.isError
        ? "failed"
        : (repoLookup.data?.status ?? "checking");
  // The repository already syncing is neither seeded nor replaced: it is kept.
  const keepsSource =
    !!editing && provider === editing.provider && repo === editing.repo;
  const repoStatus: RepositoryStatus =
    keepsSource && USABLE.has(lookedUp) ? "current" : lookedUp;

  // Installing saves the new App as a credential and clears it from setup, so
  // remember it to recognize it in the saved Apps and carry on with it.
  const [newApp, setNewApp] = useState<{
    appId: string;
    account: string;
  } | null>(null);
  useEffect(() => {
    if (createdApp)
      setNewApp({ appId: createdApp.appId, account: createdApp.account });
  }, [createdApp]);
  const savedNewApp = newApp
    ? apps.find((app) => app.appId === newApp.appId)
    : undefined;
  useEffect(() => {
    if (step !== "app" || installed || !savedNewApp || !newApp) return;
    setInstalled({
      id: savedNewApp.id,
      name: savedNewApp.name,
      account: newApp.account,
    });
    setWaiting(null);
    setMode("create");
    setStep("repo");
  }, [step, installed, savedNewApp, newApp]);

  // Resume a setup whose App exists on an account.
  useEffect(() => {
    if (!createdApp) return;
    const url = new URL(createdApp.accountUrl);
    setGithubUrl(url.origin);
    setOwnerInput(createdApp.account);
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
    if (!github) return;
    const url = new URL(`${github.web}/new`);
    // Off github.com the template is out of reach: start empty, setup fills it.
    if (github.dotCom) {
      url.searchParams.set("template_owner", TEMPLATE.owner);
      url.searchParams.set("template_name", TEMPLATE.name);
    }
    url.searchParams.set("owner", owner);
    url.searchParams.set("name", FRESH_NAME);
    url.searchParams.set("visibility", "private");
    window.open(url, "_blank", "noopener");
    setOpenedTemplate(true);
  }

  function createApp() {
    if (!github || !ready) return;
    // Open the tab inside the click so the browser does not block it.
    const tab = openGithubWindow("about:blank");
    setWaiting("create");
    start.mutate(
      { githubUrl: github.web, owner },
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
    // GitHub's return tab can report the install twice; one check is enough.
    if (install.isPending) return;
    install.mutate(undefined, {
      onSuccess: (result) => {
        if (result?.status !== "installed") return;
        setInstalled(result);
        setWaiting(null);
        // The new App is now one of the saved ones; stay on it rather than
        // falling back to the "which App" choice, and move on to the repository.
        setMode("create");
        setStep("repo");
      },
      onError: () => setWaiting(null),
    });
  }

  // A reload often finishes too fast to notice; confirm it briefly.
  async function refreshRepositories() {
    setRefreshed(false);
    await repositories.refetch();
    setRefreshed(true);
    setTimeout(() => setRefreshed(false), 2000);
  }

  function connect() {
    if (!appId || (!repo && !creatingProject)) return;
    const onError = () => setStep("repo");
    const credential = gitlab
      ? { gitlabTokenId: appId }
      : { githubAppConfigId: appId };
    setStep("connect");
    if (keepsSource) {
      configure.mutate(
        {
          repo,
          ref: location.ref ?? null,
          path: location.path ?? "appa.toml",
          interval,
          validationDirectory: validationFolder,
          githubPatId: null,
          githubAppConfigId: null,
          gitlabTokenId: null,
          ...credential,
        },
        { onSuccess: () => onOpenChange(false), onError },
      );
      return;
    }
    // GitLab nests groups: the project is the last segment, its group the rest.
    const slash = repo.lastIndexOf("/");
    create.mutate(
      {
        ...(creatingProject
          ? { owner: chosenGroup ?? "", name: projectName.trim() }
          : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }),
        ...credential,
        interval,
        existing: !creatingProject,
        // Editing moves the running sync to the new repository.
        ...(!creatingProject && { replace: !!editing }),
        ...location,
      },
      {
        onSuccess: (data) => {
          const number = data?.source?.setupPullRequestNumber;
          if (number && data.source?.repo)
            setPullRequest({ repo: data.source.repo, number });
          else onOpenChange(false);
        },
        onError,
      },
    );
  }

  function back() {
    if (gitlab) return setStep(step === "repo" ? "app" : "provider");
    if (step === "start") {
      if (origin) return setOrigin(null);
      return setStep("provider");
    }
    if (step === "repo") {
      setStep("app");
      // A lone App was picked for the admin; go back to the choice, not a list of one.
      if (mode === "pick" && apps.length === 1) setMode("fork");
      return;
    }
    if (mode !== "fork" && apps.length > 0 && !createdApp)
      return setMode("fork");
    setStep("start");
    // An existing repository has nothing to do on the first step: go back to the choice.
    if (origin === "existing") setOrigin(null);
  }

  if (pullRequest)
    return (
      <OpenAppaSetupPullRequestDialog
        pullRequest={pullRequest}
        onOpenChange={onOpenChange}
      />
    );

  const policyDocsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAiToolGuardrailsPolicies,
    "github-sync",
  );
  const header = headerFor({
    editing: !!editing,
    step,
    origin,
    mode,
    appName,
    dotCom: github?.dotCom ?? true,
    gitlab,
  });
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
          {step !== "connect" && step !== "provider" ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={back}
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
          {step === "start" && origin === "fresh" ? (
            <Button type="button" onClick={() => setStep("app")}>
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "app" && (gitlab || mode !== "fork") ? (
            <Button
              type="button"
              disabled={!appId}
              onClick={() => setStep("repo")}
            >
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "repo" ? (
            <Button
              type="button"
              disabled={
                creatingProject
                  ? !locationValid ||
                    !PROJECT_NAME.test(projectName.trim()) ||
                    chosenGroup === undefined
                  : !repo || !locationValid || !USABLE.has(repoStatus)
              }
              onClick={connect}
            >
              <span>
                {editing
                  ? "Save"
                  : creatingProject
                    ? "Create project"
                    : gitlab
                      ? "Connect project"
                      : "Connect repository"}
              </span>
            </Button>
          ) : null}
        </>
      }
    >
      <SetupStepper
        steps={(gitlab ? GITLAB_STEPS : GITHUB_STEPS).map(
          (entry) => entry.label,
        )}
        current={
          step === "connect"
            ? (gitlab ? GITLAB_STEPS : GITHUB_STEPS).length
            : (gitlab ? GITLAB_STEPS : GITHUB_STEPS).findIndex(
                (entry) => entry.id === step,
              )
        }
      />

      {step === "provider" ? (
        <GitProviderStep
          onPick={(picked) => {
            // Moving an edited source to the other host starts that host fresh:
            // the old repository means nothing there.
            const sameHost = editing?.provider === picked;
            setRepo(sameHost ? editing.repo : "");
            setRef(sameHost ? (editing.ref ?? "") : "");
            setOrigin(sameHost ? "existing" : null);
            setProjectMode(sameHost ? "existing" : "create");
            setProvider(picked);
            setStep(picked === "gitlab" ? "app" : "start");
          }}
        />
      ) : null}

      {step === "app" && gitlab ? (
        <GitAccessStep
          provider="gitlab"
          allowPublic={false}
          access={
            gitlabToken ? { kind: "credential", credential: gitlabToken } : null
          }
          onAccessChange={(access) =>
            setGitlabTokenId(
              access?.kind === "credential" ? access.credential.id : "",
            )
          }
        />
      ) : null}

      {step === "start" && !origin ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="github-sync-host">GitHub URL</Label>
            <FieldDescription>
              Using GitHub Enterprise Server? Put its address here.
            </FieldDescription>
            <Input
              id="github-sync-host"
              value={githubUrl}
              placeholder={DOT_COM_WEB}
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              aria-invalid={!github}
              onChange={(event) => setGithubUrl(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="github-sync-owner">Organization</Label>
            <FieldDescription>
              The GitHub organization for the policy repository.
            </FieldDescription>
            <Input
              id="github-sync-owner"
              value={ownerInput}
              placeholder="acme"
              autoComplete="off"
              data-1p-ignore
              spellCheck={false}
              aria-invalid={!!ownerInput.trim() && !OWNER_PATTERN.test(owner)}
              onChange={(event) => setOwnerInput(event.target.value)}
            />
          </div>
        </div>
      ) : null}

      {step === "start" && !origin ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceTile
            disabled={!ready}
            onClick={() => setOrigin("fresh")}
            visual={
              <span className="flex size-9 items-center justify-center rounded-lg border border-dashed">
                <Plus className="size-4 text-muted-foreground" />
              </span>
            }
            title="Start fresh"
            body={
              github && !github.dotCom
                ? `Create an empty private repository. ${appName} adds the OpenAPPA files.`
                : "Create a private repository from the OpenAPPA template."
            }
          />
          <ChoiceTile
            disabled={!ready}
            onClick={() => {
              setOrigin("existing");
              setStep("app");
            }}
            visual={
              <span className="flex size-9 items-center justify-center rounded-lg border bg-muted/40">
                <Github className="size-4" />
              </span>
            }
            title="Use an existing repository"
            body="One that already holds an OpenAPPA policy."
          />
        </div>
      ) : null}

      {step === "start" && origin === "fresh" ? (
        <div className="flex items-center gap-4 rounded-lg border bg-card p-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">
              {github?.dotCom
                ? "Create it from the OpenAPPA template"
                : "Create an empty repository"}
            </p>
            <p className="text-xs text-muted-foreground">
              {openedTemplate
                ? "Created it on GitHub? Continue to connect it."
                : github?.dotCom
                  ? "Keep it private."
                  : "Keep it private, without a README or other files."}
            </p>
          </div>
          {openedTemplate ? (
            // GitHub has no callback for repository creation; the repository
            // list on the last step shows whether it worked.
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="size-3.5 text-emerald-600" aria-hidden />
                <span>Opened on GitHub</span>
              </span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs text-muted-foreground"
                onClick={openTemplate}
              >
                <span>Open again</span>
              </Button>
            </div>
          ) : (
            <GitHubConnectButton
              label="Create on GitHub"
              onClick={openTemplate}
            />
          )}
        </div>
      ) : null}

      {step === "app" && !gitlab && loadingApps ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" />
          <span>Loading GitHub Apps…</span>
        </p>
      ) : null}

      {step === "app" && !gitlab && !loadingApps && mode === "fork" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceTile
            onClick={() => {
              setMode("pick");
              // With one App there is nothing to choose: use it.
              if (apps.length === 1) {
                setPickedId(apps[0].id);
                setStep("repo");
              }
            }}
            visual={<AppIconStack icons={apps.map((app) => app.icon)} />}
            title="Use an App I already have"
            body={`${apps.length} connected to ${appName}.`}
          />
          <ChoiceTile
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

      {step === "app" && !gitlab && !loadingApps && mode === "pick" ? (
        <RadioGroup
          value={pickedId}
          onValueChange={setPickedId}
          className="gap-2"
          aria-label="GitHub App"
        >
          {apps.map((app) => {
            const account = accounts.data?.find(
              (entry) => entry.id === app.id,
            )?.account;
            return (
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
                {account ? <AccountChip account={account} /> : null}
              </Label>
            );
          })}
        </RadioGroup>
      ) : null}

      {step === "app" && !gitlab && !loadingApps && mode === "create" ? (
        canCreateCredentials ? (
          <div className="space-y-4">
            <ol className="overflow-hidden rounded-lg border bg-card">
              <ManifestRow
                index={1}
                title="Create the App on GitHub"
                hint={`Owned by ${owner}.`}
                inlineAction
                waiting={waiting === "create"}
                error={start.error?.message}
                onCheckAgain={() => {
                  setWaiting(null);
                  pending.refetch();
                }}
                result={
                  installed && !createdApp ? (
                    <>
                      <span className="text-sm text-muted-foreground">
                        Created
                      </span>
                      <span className="truncate text-sm font-medium">
                        {installed.name}
                      </span>
                    </>
                  ) : createdApp ? (
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
                    label="Create App"
                    pending={start.isPending}
                    disabled={!ready}
                    onClick={createApp}
                  />
                }
              />
              <ManifestRow
                index={2}
                title="Install it on the policy repository"
                hint="On GitHub, choose Only select repositories, then your policy repository."
                locked={!createdApp && !installed}
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
                      <AccountChip account={installed.account} />
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
            <AccessSummary workflows={!github?.dotCom} />
          </div>
        ) : (
          <InlineNotice variant="info">
            <InlineNoticeText className="flex-1">
              Ask an administrator who can create credentials to set up the
              GitHub App.
            </InlineNoticeText>
          </InlineNotice>
        )
      ) : null}

      {step === "repo" ? (
        <div className="space-y-4">
          {gitlab ? (
            <SelectedAppBar
              provider="gitlab"
              name={gitlabToken?.name ?? "GitLab token"}
              icon="logo:gitlab"
              account={gitlabToken ? new URL(gitlabToken.webUrl).host : null}
              onChange={back}
            />
          ) : (
            <SelectedAppBar
              provider="github"
              name={appLabel ?? "GitHub App"}
              icon={
                mode === "pick"
                  ? (apps.find((app) => app.id === pickedId)?.icon ?? null)
                  : (apps.find((app) => app.id === installed?.id)?.icon ?? null)
              }
              account={
                mode === "pick"
                  ? (accounts.data?.find((entry) => entry.id === pickedId)
                      ?.account ?? null)
                  : (installed?.account ?? null)
              }
              onChange={back}
            />
          )}
          {gitlab && !editing ? (
            <RadioGroup
              value={projectMode}
              onValueChange={(value) =>
                setProjectMode(value as "create" | "existing")
              }
              className="grid-cols-2 gap-2"
              aria-label="Policy project"
            >
              {(
                [
                  ["create", "New project"],
                  ["existing", "Existing project"],
                ] as const
              ).map(([value, label]) => (
                <Label
                  key={value}
                  htmlFor={`gitlab-project-${value}`}
                  className={cn(
                    radioCardClass(),
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 font-normal",
                  )}
                >
                  <RadioGroupItem
                    value={value}
                    id={`gitlab-project-${value}`}
                  />
                  <span className="text-sm font-medium">{label}</span>
                </Label>
              ))}
            </RadioGroup>
          ) : null}
          {creatingProject ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="gitlab-project-group">Group</Label>
                {namespaces.isPending ? (
                  <div className="flex h-9 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin" />
                    <span>Loading…</span>
                  </div>
                ) : (
                  <Select
                    value={chosenGroup === "" ? PERSONAL : (chosenGroup ?? "")}
                    onValueChange={(value) =>
                      setGroup(value === PERSONAL ? "" : value)
                    }
                  >
                    <SelectTrigger id="gitlab-project-group" className="w-full">
                      <SelectValue placeholder="Choose a group" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {(namespaces.data ?? []).map((entry) => (
                        <SelectItem
                          key={entry || PERSONAL}
                          value={entry || PERSONAL}
                        >
                          {entry || "Your namespace"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="gitlab-project-name">Project name</Label>
                <Input
                  id="gitlab-project-name"
                  value={projectName}
                  autoComplete="off"
                  data-1p-ignore
                  spellCheck={false}
                  aria-invalid={!PROJECT_NAME.test(projectName.trim())}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-2">
                Private. {appName} adds the OpenAPPA files.
              </p>
              {namespaces.isError ? (
                <InlineNotice variant="error" className="sm:col-span-2">
                  <AlertTriangle aria-hidden />
                  <span className="font-medium">Couldn't load groups</span>
                  <InlineNoticeText className="flex-1">
                    {namespaces.error.message}
                  </InlineNoticeText>
                </InlineNotice>
              ) : null}
            </div>
          ) : null}
          {creatingProject ? null : (
            <div className="space-y-2">
              <Label htmlFor="github-sync-repo">
                {gitlab ? "Project" : "Repository"}
              </Label>
              <FieldDescription>
                {gitlab
                  ? "Projects the token can reach."
                  : "The repositories the selected App can access."}
                {repositories.data?.manageUrl ? (
                  <>
                    {" "}
                    <span>Don't see yours?</span>{" "}
                    <a
                      href={repositories.data.manageUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      <span>Change its access on GitHub</span>
                      <ExternalLink className="size-3" aria-hidden />
                    </a>
                    <span>, then </span>
                    <Button
                      type="button"
                      variant="link"
                      size="xs"
                      className="h-auto gap-1 px-0 align-baseline text-xs font-medium text-foreground"
                      disabled={repositories.isFetching}
                      onClick={refreshRepositories}
                      aria-live="polite"
                    >
                      {/* The word never changes width, or the link would wrap
                        onto its own line: a spinner covers it while loading,
                        and it turns green for a moment once done. */}
                      <span className="relative">
                        <span
                          className={cn(
                            repositories.isFetching && "invisible",
                            refreshed &&
                              "text-emerald-600 dark:text-emerald-500",
                          )}
                        >
                          refresh
                        </span>
                        {repositories.isFetching && (
                          <LoaderCircle
                            className="absolute inset-0 m-auto size-3 animate-spin"
                            aria-hidden
                          />
                        )}
                      </span>
                      {repositories.isFetching ? (
                        <span className="sr-only">Refreshing</span>
                      ) : refreshed ? (
                        <span className="sr-only">Refreshed</span>
                      ) : null}
                    </Button>
                    <span>.</span>
                  </>
                ) : null}
              </FieldDescription>
              {repositories.isPending ? (
                <div className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  <span>Loading repositories…</span>
                </div>
              ) : repositories.data?.repositories.length ? (
                <SearchableSelect
                  id="github-sync-repo"
                  className="h-10 w-full"
                  value={repo}
                  onValueChange={setRepo}
                  placeholder="Choose a repository"
                  searchPlaceholder="Search repositories…"
                  emptyMessage="No repository matches."
                  listClassName="max-h-72"
                  items={repositories.data.repositories.map((entry) => ({
                    value: entry.fullName,
                    label: entry.fullName,
                    searchText: `${entry.fullName} ${entry.description ?? ""}`,
                    content: <RepositoryOption repository={entry} />,
                    selectedContent: (
                      <RepositoryOption repository={entry} compact />
                    ),
                  }))}
                />
              ) : (
                <InlineNotice
                  variant={repositories.isError ? "error" : "warning"}
                >
                  <AlertTriangle aria-hidden />
                  <span className="font-medium">
                    {repositories.isError
                      ? "Couldn't load repositories"
                      : "No repositories yet"}
                  </span>
                  <InlineNoticeText className="flex-1">
                    {repositories.isError
                      ? repositories.error.message
                      : gitlab
                        ? "The token can't reach any project."
                        : `${appLabel ?? "The App"} can't access any. Give it access on GitHub.`}
                  </InlineNoticeText>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="ml-auto h-auto px-0 text-xs text-inherit"
                    data-slot="inline-notice-action"
                    disabled={repositories.isFetching}
                    onClick={() => repositories.refetch()}
                  >
                    <span>Try again</span>
                  </Button>
                </InlineNotice>
              )}
            </div>
          )}
          {repo && !creatingProject ? (
            <RepositoryNotice
              path={location.path ?? "appa.toml"}
              folder={validationFolder}
              status={repoStatus}
              validations={repoLookup.data?.validations ?? null}
              error={repoLookup.error?.message}
              manageUrl={repositories.data?.manageUrl ?? null}
              gitlab={gitlab}
            />
          ) : null}
          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
              <span>Advanced</span>
              <span className="font-normal text-muted-foreground/70">
                (branch, policy file, validations, schedule)
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="github-sync-ref">Branch</Label>
                  <FieldDescription>Where the policy is read.</FieldDescription>
                  <Input
                    id="github-sync-ref"
                    value={ref}
                    placeholder="Default branch"
                    autoComplete="off"
                    data-1p-ignore
                    spellCheck={false}
                    onChange={(event) => setRef(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="github-sync-path">Policy file</Label>
                  <FieldDescription>
                    Path from the repository root.
                    <DocsLink href={policyDocsUrl} />
                  </FieldDescription>
                  <Input
                    id="github-sync-path"
                    value={path}
                    placeholder="appa.toml"
                    autoComplete="off"
                    data-1p-ignore
                    spellCheck={false}
                    aria-invalid={
                      !!location.path && !POLICY_PATH.test(location.path)
                    }
                    onChange={(event) => setPath(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="github-sync-validations">
                    Validations folder
                  </Label>
                  <FieldDescription>
                    Files that test the policy.
                    <DocsLink href={VALIDATION_GUIDE_URL} />
                  </FieldDescription>
                  <Input
                    id="github-sync-validations"
                    value={validations}
                    placeholder={DEFAULT_VALIDATIONS}
                    autoComplete="off"
                    data-1p-ignore
                    spellCheck={false}
                    aria-invalid={
                      !!location.validationDirectory &&
                      !DIRECTORY_PATH.test(location.validationDirectory)
                    }
                    onChange={(event) => setValidations(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="github-sync-interval">Sync schedule</Label>
                  <FieldDescription>
                    How often to check for merges.
                  </FieldDescription>
                  <Select
                    value={interval}
                    onValueChange={(value) =>
                      setSyncInterval(value as SyncInterval)
                    }
                  >
                    <SelectTrigger id="github-sync-interval" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {SYNC_INTERVALS.map((entry) => (
                        <SelectItem key={entry.value} value={entry.value}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          {(keepsSource ? configure.error : create.error) ? (
            <InlineNotice variant="error">
              <AlertTriangle aria-hidden />
              <span className="font-medium">
                {keepsSource
                  ? "Couldn't save"
                  : `Couldn't connect ${creatingProject ? projectName.trim() : repo}`}
              </span>
              <InlineNoticeText className="basis-full pl-5">
                {(keepsSource ? configure.error : create.error)?.message}
              </InlineNoticeText>
            </InlineNotice>
          ) : null}
        </div>
      ) : null}

      {step === "connect" ? (
        <ul
          className="space-y-3 rounded-lg border bg-card p-4"
          aria-live="polite"
        >
          {[
            gitlab ? "Check the project" : "Check the repository",
            "Sync the policy",
            `Open a setup ${gitChangeRequestNoun(gitlab ? "gitlab" : "github")} if rules require one`,
          ].map((label, index) => (
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
    </StandardDialog>
  );
}

// ===================== Internals =====================

type Step = "provider" | "start" | "app" | "repo" | "connect";
type AppMode = "fork" | "pick" | "create";
type Origin = "fresh" | "existing";
type RepositoryStatus =
  | "checking"
  | "current"
  | "template"
  | "empty"
  | "policy"
  | "other"
  | "unreachable"
  | "app_error"
  | "failed";

/** What setup will do with an existing repository, once it has looked it up. */
function RepositoryNotice({
  path,
  folder,
  status,
  validations,
  error,
  manageUrl,
  gitlab = false,
}: {
  path: string;
  folder: string;
  status: RepositoryStatus;
  validations: boolean | null;
  error?: string;
  manageUrl: string | null;
  gitlab?: boolean;
}) {
  if (status === "checking")
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" />
        <span>Looking for the policy…</span>
      </p>
    );
  if (status === "unreachable" || status === "app_error" || status === "failed")
    return (
      <InlineNotice variant="error" aria-live="polite">
        <AlertTriangle aria-hidden />
        <span className="font-medium">
          {status === "app_error"
            ? gitlab
              ? "The token can't sign in"
              : "The App can't sign in"
            : status === "unreachable"
              ? "No access"
              : "Couldn't check it"}
        </span>
        <InlineNoticeText className="flex-1">
          {status === "app_error"
            ? gitlab
              ? "It may be revoked or expired. Change it above."
              : "It may be uninstalled on GitHub. Change it above."
            : status === "unreachable"
              ? gitlab
                ? "The token can't read this project."
                : "The selected App can't read this repository."
              : (error ?? "Try again in a moment.")}
        </InlineNoticeText>
        {status === "unreachable" && manageUrl ? (
          <NoticeLink href={manageUrl}>Change access</NoticeLink>
        ) : null}
      </InlineNotice>
    );
  const usable = USABLE.has(status);
  return (
    <div className="space-y-2" aria-live="polite">
      {/* The repository already syncing needs no note; only a warning. */}
      {status !== "current" && (
        <InlineNotice variant={usable ? "success" : "warning"}>
          {usable ? <Check aria-hidden /> : <AlertTriangle aria-hidden />}
          <span className="font-medium">
            {status === "template"
              ? "OpenAPPA template"
              : status === "empty"
                ? gitlab
                  ? "Empty project"
                  : "Empty repository"
                : status === "policy"
                  ? `Found ${path}`
                  : `No ${path}`}
          </span>
          <InlineNoticeText className="flex-1">
            {status === "template"
              ? "Setup copies your current policy into it."
              : status === "empty"
                ? "Setup adds the OpenAPPA files and your current policy."
                : status === "policy"
                  ? "It becomes your policy, in place of the current one."
                  : `Pick another ${gitlab ? "project" : "repository"}, or set the policy's location under Advanced.`}
          </InlineNoticeText>
        </InlineNotice>
      )}
      {(status === "policy" || status === "current") &&
      validations === false ? (
        <InlineNotice variant="warning">
          <AlertTriangle aria-hidden />
          <span className="font-medium">No {folder}/ folder</span>
          <InlineNoticeText className="flex-1">
            Validations run once you add .appa files to it.
          </InlineNoticeText>
          <NoticeLink href={VALIDATION_GUIDE_URL}>About validations</NoticeLink>
        </InlineNotice>
      ) : null}
    </div>
  );
}

/** The App the repository list comes from, with a way back to change it. */
function SelectedAppBar({
  provider,
  name,
  icon,
  account,
  onChange,
}: {
  provider: GitProvider;
  name: string;
  icon: string | null;
  account: string | null;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs">
      <RuntimeCredentialIcon
        icon={icon ?? "logo:github"}
        className="size-3.5"
        size={14}
      />
      <span className="min-w-0 truncate font-medium">{name}</span>
      {account ? <AccountChip account={account} provider={provider} /> : null}
      <Button
        type="button"
        variant="link"
        size="xs"
        className="ml-auto h-auto px-0 text-xs text-muted-foreground"
        onClick={onChange}
      >
        <span>Change</span>
      </Button>
    </div>
  );
}

/** A trailing "Docs" link for a field description; hidden when docs are. */
function DocsLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <>
      {" "}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 font-medium text-foreground underline-offset-4 hover:underline"
      >
        <span>Docs</span>
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </>
  );
}

function NoticeLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      data-slot="inline-notice-action"
      className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium underline-offset-4 hover:underline"
    >
      <span>{children}</span>
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/** A repository row: owner dimmed, name bold, a lock when private. */
function RepositoryOption({
  repository,
  compact = false,
}: {
  repository: {
    fullName: string;
    private: boolean;
    description: string | null;
    template: boolean;
  };
  compact?: boolean;
}) {
  // GitLab nests groups: the name is the last segment, the rest its group.
  const slash = repository.fullName.lastIndexOf("/");
  const owner = repository.fullName.slice(0, slash);
  const name = repository.fullName.slice(slash + 1);
  const Icon = repository.private ? Lock : BookMarked;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">
            <span className="text-muted-foreground">{owner}/</span>
            <span className="font-medium">{name}</span>
          </span>
          {repository.template ? (
            <Badge
              variant="secondary"
              className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
            >
              Template
            </Badge>
          ) : null}
        </span>
        {!compact && repository.description ? (
          <span className="block truncate text-xs text-muted-foreground">
            {repository.description}
          </span>
        ) : null}
      </span>
    </span>
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

/** Off github.com the App also writes the validation workflow into the new repository. */
function AccessSummary({ workflows }: { workflows: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 px-4 py-3">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-muted-foreground">
          The App only needs the policy repository, nothing else in the
          organization:
        </p>
        <div className="flex flex-wrap gap-1.5">
          {[
            "Contents",
            "Pull requests",
            ...(workflows ? ["Workflows"] : []),
          ].map((permission) => (
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

function AccountChip({
  account,
  provider = "github",
}: {
  account: string;
  provider?: GitProvider;
}) {
  return (
    <Badge variant="outline" className="bg-background font-mono font-normal">
      <GitProviderLogo provider={provider} size={12} />
      <span>{account}</span>
    </Badge>
  );
}

function headerFor(params: {
  editing: boolean;
  step: Step;
  origin: Origin | null;
  mode: AppMode;
  appName: string;
  dotCom: boolean;
  gitlab: boolean;
}) {
  if (params.step === "provider")
    return {
      title: "Set up Git sync",
      description: `GitHub or GitLab. ${params.appName} only gets access to the one policy repository.`,
    };
  if (params.gitlab) {
    if (params.step === "app")
      return {
        title: "Choose a GitLab token",
        description:
          "It needs the api scope on the policy project. A project or group token is best.",
      };
    if (params.editing && (params.step === "repo" || params.step === "connect"))
      return {
        title: "Edit GitLab sync",
        description: "Change the project or how it syncs.",
      };
    if (params.step === "repo")
      return {
        title: "Choose the policy project",
        description: "Create a private one, or use one you have.",
      };
    return {
      title: "Connecting the project",
      description: "This takes a few seconds.",
    };
  }
  if (params.step === "start")
    return params.origin === "fresh"
      ? {
          title: "Start a policy repository",
          description: params.dotCom
            ? "GitHub creates a private copy of the OpenAPPA template."
            : `Once it is connected, ${params.appName} adds the OpenAPPA files.`,
        }
      : {
          title: "Set up GitHub sync",
          description: `Where should your policy live? ${params.appName} only ever gets access to that one repository.`,
        };
  if (params.step === "app") {
    if (params.mode === "fork")
      return {
        title: "Connect a GitHub App",
        description: `${params.appName} reads and proposes policy changes through a GitHub App.`,
      };
    if (params.mode === "pick")
      return {
        title: "Choose a GitHub App",
        description: "Next, pick the policy repository it can see.",
      };
    return {
      title: "Create a GitHub App",
      description: "GitHub creates the App for you. No IDs or keys to copy.",
    };
  }
  if (params.editing && (params.step === "repo" || params.step === "connect"))
    return {
      title: "Edit GitHub sync",
      description: "Change the repository or how it syncs.",
    };
  if (params.step === "repo")
    return {
      title: "Choose the policy repository",
      description: "From the repositories the GitHub App can see.",
    };
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

const GITHUB_STEPS: { id: Step; label: string }[] = [
  { id: "provider", label: "Host" },
  { id: "start", label: "Start" },
  { id: "app", label: "GitHub App" },
  { id: "repo", label: "Repository" },
];
const GITLAB_STEPS: { id: Step; label: string }[] = [
  { id: "provider", label: "Host" },
  { id: "app", label: "Token" },
  { id: "repo", label: "Project" },
];
const PERSONAL = "__personal__";
/** GitLab project names: letters, digits, and `_ . -`, starting with one of the first two. */
const PROJECT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;

const TEMPLATE = { owner: "archestra-ai", name: "openappa-config" };
const OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const DOT_COM_API = "https://api.github.com";
const DOT_COM_WEB = "https://github.com";
const FRESH_NAME = "openappa-policy";
const USABLE = new Set<RepositoryStatus>([
  "template",
  "empty",
  "policy",
  "current",
]);

/** A GitHub address becomes its web and API bases; any path is ignored. */
function parseGithubUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname.includes(".")
  )
    return null;
  return {
    dotCom: url.hostname === "github.com",
    web: url.origin,
    api: getGithubApiBaseUrl(url.origin),
  };
}

/** A pasted profile or repository URL names its owner: github.com/acme/repo is acme. */
function ownerFromInput(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return trimmed;
  try {
    const url = new URL(
      trimmed.includes("://") ? trimmed : `https://${trimmed}`,
    );
    return url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return trimmed;
  }
}
const DEFAULT_VALIDATIONS = "traces";
type SyncInterval = "15m" | "1h" | "1d";
const DEFAULT_INTERVAL: SyncInterval = "1h";
const SYNC_INTERVALS: { value: SyncInterval; label: string }[] = [
  { value: "15m", label: "Every 15 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "1d", label: "Once a day" },
];

type EditedSource = {
  provider: GitProvider;
  /** The GitHub App or GitLab token the source reads with. */
  credentialId: string;
  repo: string;
  ref: string | null;
  path: string;
  interval: SyncInterval;
  /** Empty when validations are off; they then default to traces here. */
  validationDirectory: string;
  /** The host's web address, e.g. https://github.com. */
  webUrl: string;
};
const VALIDATION_GUIDE_URL = "https://www.openappa.com/validation";
const DIRECTORY_PATH = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;
const POLICY_PATH = /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.toml$/;

const APP_LOGO_PATH = "/openappa/github-app-logo.png";
