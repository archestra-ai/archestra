"use client";

import { ArrowLeft, CircleAlert, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { SetupStepper } from "@/components/git/git-setup-chrome";
import { AccessNote } from "@/components/github-app-setup/access-summary";
import {
  type AppKeyFields,
  ConnectAppByKey,
} from "@/components/github-app-setup/connect-app-by-key";
import {
  GITHUB_DOT_COM_WEB,
  GithubAccountFields,
  readGithubAccountFields,
} from "@/components/github-app-setup/github-account-fields";
import { GithubAppChoice } from "@/components/github-app-setup/github-app-choice";
import { GithubAppPicker } from "@/components/github-app-setup/github-app-picker";
import {
  onGithubAppSetup,
  openGithubWindow,
  postManifest,
} from "@/components/github-app-setup/github-app-window";
import { ManifestRow } from "@/components/github-app-setup/manifest-row";
import type { PrivateKeyStatus } from "@/components/github-app-setup/private-key-drop";
import { shortGithubAppError } from "@/components/github-app-setup/short-error";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCheckCopilotGithubOrganization,
  useConnectCopilotGithubAppCredential,
  useConnectExistingCopilotGithubApp,
  useCopilotGithubAppKeySummary,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useLlmProviderApiKey,
  useUpdateLlmProviderApiKey,
} from "@/lib/llm-provider-api-keys.query";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";
import {
  COPILOT_GITHUB_TAB,
  COPILOT_SETUP_CHANNEL,
} from "./copilot-github-app-setup";
import {
  COPILOT_DIALOG_CLASS,
  GithubAppRow,
  OrganizationRow,
} from "./copilot-organization-parts";

type Step = "organization" | "app" | "access";
type AppMode = "choose" | "pick" | "create" | "key";

/**
 * Connects and manages GitHub Copilot paid by a GitHub organization, in the
 * shared GitHub App setup steps and components: the
 * organization, then its GitHub App (one already connected, a new one
 * registered on GitHub, or one by its ID and private key), then who may use
 * it. Every step but the first goes back. Once a key exists (managed, or
 * connected in this session) its organization is fixed and the App step
 * replaces the App of that same key.
 */
export function CopilotOrganizationConnectDialog({
  open,
  onOpenChange,
  manage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Manage this key, from its organization. A reconnect opens at the App
   * step: the key's App stopped working.
   */
  manage?: {
    id: string;
    name: string;
    organization: string | null;
    reconnect?: boolean;
  } | null;
}) {
  const appName = useAppName();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const { data: canCreateCredentials } = useHasPermissions({
    credential: ["create"],
  });
  const credentials = useRuntimeCredentials(open && !!canReadCredentials);
  const [step, setStep] = useState<Step>(
    manage?.reconnect ? "app" : "organization",
  );
  const [mode, setMode] = useState<AppMode>("choose");
  const [githubUrl, setGithubUrl] = useState(GITHUB_DOT_COM_WEB);
  const [organizationInput, setOrganizationInput] = useState(
    manage?.organization ?? "",
  );
  const [organization, setOrganization] = useState(manage?.organization ?? "");
  const [pickedId, setPickedId] = useState("");
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  // The key this session connected; going back from Access reconnects it.
  const [connectedKeyId, setConnectedKeyId] = useState<string | null>(null);
  const [keyFields, setKeyFields] = useState<AppKeyFields | null>(null);
  // Optional, as on any provider key: empty means the default name.
  const [nameDraft, setNameDraft] = useState(manage?.name ?? "");

  const check = useCheckCopilotGithubOrganization();
  const pending = usePendingCopilotGithubApp(open && !!canCreateCredentials);
  const start = useStartCopilotGithubApp();
  const install = useInstallCopilotGithubApp();
  const discard = useDiscardCopilotGithubApp();
  const fromCredential = useConnectCopilotGithubAppCredential();
  const validate = useValidateExistingCopilotGithubApp();
  const byKey = useConnectExistingCopilotGithubApp();
  const update = useUpdateLlmProviderApiKey();
  const createdApp = pending.data ?? null;
  // Managing, or back from Access: the App step replaces this key's App and
  // its organization stays.
  const replaceKeyId = manage?.id ?? connectedKeyId;
  const summary = useCopilotGithubAppKeySummary(open ? replaceKeyId : null);
  const currentApp = replaceKeyId ? (summary.data ?? null) : null;
  const keyDetail = useLlmProviderApiKey(
    open && step === "access" ? (replaceKeyId ?? undefined) : undefined,
  );
  const keyName = keyDetail.data?.name ?? manage?.name ?? "";

  // The two fields as the backend takes them: a login on github.com, else
  // the organization's address on its GitHub.
  const account = readGithubAccountFields({
    githubUrl,
    organization: organizationInput,
    // The plan setup reads GitHub from the server: https only.
    httpsOnly: true,
  });
  // An App lives on one GitHub; only those on the organization's can serve it.
  const host = account.account;
  const defaultLogin = replaceKeyId
    ? organization
    : account.account?.login || organizationInput.trim();
  const defaultName = defaultLogin
    ? `GitHub Copilot (${defaultLogin})`
    : "GitHub Copilot";
  // Empty falls back to the default.
  const name = nameDraft.trim() || defaultName;
  const apps =
    credentials.data?.filter(
      (credential) =>
        credential.allowOrganization &&
        credential.organizationConfigured &&
        credential.kind === "github_app" &&
        (!host ||
          (credential.githubUrl ?? "https://api.github.com").replace(
            /\/+$/,
            "",
          ) === host.api) &&
        // The App in use is not another App to switch to.
        !(currentApp && credential.appId === currentApp.appId),
    ) ?? [];

  // A managed plan's organization is on the GitHub its App is on.
  const managedGithubUrl = manage ? currentApp?.githubUrl : undefined;
  useEffect(() => {
    if (managedGithubUrl) setGithubUrl(managedGithubUrl);
  }, [managedGithubUrl]);

  // An App created earlier still awaits installation: pick up where setup stopped.
  useEffect(() => {
    if (!createdApp || replaceKeyId) return;
    setOrganization(createdApp.account);
    setGithubUrl(new URL(createdApp.accountUrl).origin);
    setOrganizationInput(createdApp.account);
    setMode("create");
    setStep((current) => (current === "organization" ? "app" : current));
  }, [createdApp, replaceKeyId]);

  // The return tab reports back once GitHub finishes each step.
  const onSetupStep = useRef<(done: "created" | "installed") => void>(() => {});
  onSetupStep.current = (done) => {
    if (done === "installed") return checkInstall();
    setWaiting(null);
    pending.refetch();
  };
  useEffect(
    () =>
      onGithubAppSetup(
        (done) => onSetupStep.current(done),
        COPILOT_SETUP_CHANNEL,
      ),
    [],
  );
  // An owner may have to approve the install: keep checking while waiting.
  useEffect(() => {
    if (waiting !== "install") return;
    const timer = setInterval(() => onSetupStep.current("installed"), 5000);
    return () => clearInterval(timer);
  }, [waiting]);

  function connected(value: { id: string; organization: string }) {
    setConnectedKeyId(value.id);
    setOrganization(value.organization);
    setOrganizationInput(value.organization);
    setWaiting(null);
    setStep("access");
  }

  function continueFromOrganization() {
    if (replaceKeyId) {
      setMode("choose");
      setStep("app");
      return;
    }
    check.mutate(
      { organization: account.input },
      {
        onSuccess: (checked) => {
          if (!checked) return;
          setOrganization(checked.organization);
          setStep("app");
        },
      },
    );
  }

  function createApp() {
    // Open the tab inside the click so the browser does not block it.
    const tab = openGithubWindow("about:blank", COPILOT_GITHUB_TAB);
    setWaiting("create");
    start.mutate(
      { organization: account.input },
      {
        onSuccess: (manifest) => {
          if (manifest) postManifest(manifest, COPILOT_GITHUB_TAB);
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
    openGithubWindow(createdApp.installUrl, COPILOT_GITHUB_TAB);
    setWaiting("install");
  }

  function checkInstall() {
    // The return tab can report the install twice; one check is enough.
    if (install.isPending) return;
    install.mutate(replaceKeyId ? { replaceKeyId } : { name }, {
      onSuccess: (installed) => {
        if (installed?.status === "installed") connected(installed);
      },
      onError: () => setWaiting(null),
    });
  }

  function usePicked() {
    if (!pickedId) return;
    fromCredential.mutate(
      replaceKeyId
        ? { credentialId: pickedId, replaceKeyId }
        : { credentialId: pickedId, organization: account.input, name },
      {
        onSuccess: (answer) => {
          if (answer?.status === "installed") connected(answer);
        },
      },
    );
  }

  function back() {
    if (step === "access") {
      setMode("choose");
      setStep("app");
      return;
    }
    if (step === "app" && mode !== "choose") {
      setMode("choose");
      fromCredential.reset();
      validate.reset();
      byKey.reset();
      setKeyFields(null);
      return;
    }
    setStep("organization");
  }

  function done() {
    if (!replaceKeyId || name === keyName) return onOpenChange(false);
    update.mutate(
      { id: replaceKeyId, data: { name } },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  function connectByKey() {
    if (!keyFields) return;
    byKey.mutate(
      { ...keyFields, ...connectTarget },
      { onSuccess: (answer) => answer && connected(answer) },
    );
  }

  const needsPermission =
    fromCredential.data?.status === "needs_permission"
      ? fromCredential.data
      : null;
  const keyTarget = replaceKeyId
    ? { replaceKeyId }
    : { organization: account.input };
  // A new key is created with the name from the Organization step.
  const connectTarget = replaceKeyId ? keyTarget : { ...keyTarget, name };
  // Messages for the whole step, not one field: they sit at the bottom of
  // the step and grow up into free space, so nothing above them moves.
  const stepMessage =
    step === "app" && mode === "pick" && needsPermission ? (
      <InlineNotice variant="warning">
        <CircleAlert aria-hidden />
        <InlineNoticeBody>
          <span className="font-medium">
            {`${needsPermission.appName} can't make Copilot requests yet.`}
          </span>
          <InlineNoticeText>
            {`Add Copilot Requests (Read-only) in its settings. An owner of ${needsPermission.organization} must approve the change.`}
          </InlineNoticeText>
        </InlineNoticeBody>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button variant="outline" size="xs" asChild>
            <a
              href={needsPermission.settingsUrl}
              target="_blank"
              rel="noreferrer"
            >
              <span>Open settings</span>
              <ExternalLink className="size-3" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={fromCredential.isPending}
            onClick={usePicked}
          >
            <span>Check again</span>
          </Button>
        </div>
      </InlineNotice>
    ) : step === "app" && mode === "pick" && fromCredential.error ? (
      <ErrorNotice
        message={shortGithubAppError(fromCredential.error.message)}
      />
    ) : step === "access" && update.error ? (
      <ErrorNotice message={update.error.message} />
    ) : null;
  const keyStatus: PrivateKeyStatus = byKey.error
    ? { kind: "error", message: shortGithubAppError(byKey.error.message) }
    : validate.isPending
      ? { kind: "checking" }
      : validate.error
        ? {
            kind: "error",
            message: shortGithubAppError(validate.error.message),
          }
        : validate.data
          ? { kind: "fingerprint", fingerprint: validate.data.fingerprint }
          : // Before a new key is dropped: the key in use.
            currentApp && !keyFields
            ? { kind: "fingerprint", fingerprint: currentApp.fingerprint }
            : { kind: "idle" };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        manage?.reconnect
          ? "Reconnect GitHub Copilot"
          : manage
            ? "Manage GitHub Copilot"
            : "Connect GitHub Copilot"
      }
      description={
        manage && !manage.reconnect
          ? "Your enterprise GitHub Copilot plan. Can be shared."
          : "Connect your enterprise GitHub Copilot plan. Can be shared."
      }
      size="medium"
      className={COPILOT_DIALOG_CLASS}
      // A column, so the step message can sit at its bottom.
      bodyClassName="flex flex-col gap-5"
      footer={
        <>
          {step !== "organization" ? (
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
          {step === "access" ? (
            <Button type="button" disabled={update.isPending} onClick={done}>
              <span>{update.isPending ? "Saving..." : "Done"}</span>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              <span>Cancel</span>
            </Button>
          )}
          {step === "organization" ? (
            <Button
              type="button"
              disabled={!replaceKeyId && (!account.account || check.isPending)}
              onClick={continueFromOrganization}
            >
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "app" && mode === "choose" && replaceKeyId ? (
            // Keep the App in use.
            <Button type="button" onClick={() => setStep("access")}>
              <span>Continue</span>
            </Button>
          ) : null}
          {step === "app" && mode === "pick" ? (
            <Button
              type="button"
              disabled={!pickedId || fromCredential.isPending}
              onClick={usePicked}
            >
              <span>
                {fromCredential.isPending ? "Checking..." : "Use this App"}
              </span>
            </Button>
          ) : null}
          {step === "app" && mode === "key" ? (
            <Button
              type="button"
              disabled={
                !keyFields ||
                !validate.data ||
                validate.isPending ||
                byKey.isPending
              }
              onClick={connectByKey}
            >
              <span>
                {byKey.isPending
                  ? "Connecting..."
                  : replaceKeyId
                    ? "Replace credentials"
                    : "Connect"}
              </span>
            </Button>
          ) : null}
        </>
      }
    >
      <SetupStepper
        steps={STEPS.map((entry) => entry.label)}
        current={STEPS.findIndex((entry) => entry.id === step)}
      />

      {step === "organization" ? (
        <GithubAccountFields
          idPrefix="copilot-org"
          githubUrl={githubUrl}
          onGithubUrlChange={(value) => {
            check.reset();
            setGithubUrl(value);
          }}
          organization={organizationInput}
          onOrganizationChange={(value) => {
            check.reset();
            setOrganizationInput(value);
          }}
          organizationHelp="The GitHub organization with the Copilot plan."
          // A connected plan keeps its account: shown, not editable.
          disabled={!!replaceKeyId}
          urlError={replaceKeyId ? null : account.urlError}
          organizationError={
            replaceKeyId
              ? null
              : (account.organizationError ??
                (check.error ? shortGithubAppError(check.error.message) : null))
          }
        />
      ) : null}
      {step === "organization" ? (
        <div className="space-y-2">
          <Label htmlFor="copilot-key-name">
            Name{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </Label>
          <Input
            id="copilot-key-name"
            value={nameDraft}
            placeholder={defaultName}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            maxLength={256}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </div>
      ) : null}

      {step === "app" && (organization || currentApp) ? (
        <div className="space-y-2">
          {organization ? (
            <OrganizationRow organization={organization} />
          ) : null}
          {currentApp ? (
            <GithubAppRow
              name={currentApp.appName ?? `App ${currentApp.appId}`}
              icon={currentApp.appIcon}
              url={currentApp.appUrl}
            />
          ) : null}
        </div>
      ) : null}

      {step === "app" && mode === "choose" ? (
        <div className="space-y-3">
          <GithubAppChoice
            icons={apps.map((app) => app.icon)}
            appName={appName}
            canCreate={!!canCreateCredentials}
            onUseExisting={() => {
              setMode("pick");
              if (apps.length === 1) setPickedId(apps[0].id);
            }}
            onCreate={() => setMode("create")}
            onConnectByKey={() => setMode("key")}
            others={!!currentApp}
          />
          <AccessNote>
            {`The App can only make Copilot requests, billed to ${organization}. Set a spending cap in `}
            <Link
              href="/llm/costs"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Costs & Limits
            </Link>
            .
          </AccessNote>
        </div>
      ) : null}

      {step === "app" && mode === "pick" ? (
        <div className="space-y-3">
          <GithubAppPicker
            idPrefix="copilot-app"
            value={pickedId}
            onChange={(id) => {
              fromCredential.reset();
              setPickedId(id);
            }}
            apps={apps.map((app) => ({
              id: app.id,
              name: app.name,
              icon: app.icon,
            }))}
          />
        </div>
      ) : null}

      {step === "app" && mode === "create" ? (
        <div className="space-y-4">
          <ol className="overflow-hidden rounded-lg border bg-card">
            <ManifestRow
              index={1}
              title="Create the App on GitHub"
              hint={`Owned by ${organization}. It may only make Copilot requests.`}
              inlineAction
              waiting={waiting === "create"}
              error={
                start.error
                  ? shortGithubAppError(start.error.message)
                  : undefined
              }
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
                  </>
                ) : null
              }
              action={
                <GitHubConnectButton
                  label="Create App"
                  pending={start.isPending}
                  onClick={createApp}
                />
              }
            />
            <ManifestRow
              index={2}
              title={`Install it on ${organization}`}
              hint={`If you're not an owner of ${organization}, GitHub sends the request to an owner. This finishes once they approve.`}
              locked={!createdApp}
              inlineAction
              waiting={waiting === "install" || install.isPending}
              error={
                install.error
                  ? shortGithubAppError(install.error.message)
                  : undefined
              }
              onCheckAgain={checkInstall}
              result={null}
              action={
                <GitHubConnectButton
                  label="Install on GitHub"
                  disabled={!createdApp}
                  onClick={installApp}
                />
              }
            />
          </ol>
        </div>
      ) : null}

      {step === "app" && mode === "key" ? (
        <div className="space-y-4">
          <ConnectAppByKey
            // Remount once the App in use is known, to start from its ID.
            key={currentApp?.appId ?? "new"}
            defaultAppId={currentApp?.appId}
            status={keyStatus}
            onFieldsChange={(fields) => {
              validate.reset();
              byKey.reset();
              setKeyFields(fields);
            }}
            onCheck={(fields) => validate.mutate({ ...fields, ...keyTarget })}
          />
        </div>
      ) : null}

      {step === "access" && replaceKeyId ? (
        <ResourceAccessSection resource="llmProviderApiKey" id={replaceKeyId} />
      ) : null}
      {stepMessage ? <div className="mt-auto">{stepMessage}</div> : null}
    </StandardDialog>
  );
}

const STEPS: { id: Step; label: string }[] = [
  { id: "organization", label: "Organization" },
  { id: "app", label: "GitHub App" },
  { id: "access", label: "Access" },
];

function ErrorNotice({ message }: { message: string }) {
  return (
    <InlineNotice variant="error">
      <CircleAlert aria-hidden />
      <InlineNoticeText>{message}</InlineNoticeText>
    </InlineNotice>
  );
}
