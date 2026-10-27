"use client";

import { parseGithubAccountInput } from "@archestra/shared";
import { ArrowLeft, CircleAlert, ExternalLink, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SetupStepper } from "@/components/git/git-setup-chrome";
import { AccessSummary } from "@/components/github-app-setup/access-summary";
import { AccountChip } from "@/components/github-app-setup/account-chip";
import { ConnectAppByKey } from "@/components/github-app-setup/connect-app-by-key";
import { GithubAppChoice } from "@/components/github-app-setup/github-app-choice";
import { GithubAppPicker } from "@/components/github-app-setup/github-app-picker";
import {
  onGithubAppSetup,
  openGithubWindow,
  postManifest,
} from "@/components/github-app-setup/github-app-window";
import { GithubOrganizationField } from "@/components/github-app-setup/github-organization-field";
import { ManifestRow } from "@/components/github-app-setup/manifest-row";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useCheckCopilotGithubOrganization,
  useConnectCopilotGithubAppCredential,
  useConnectExistingCopilotGithubApp,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useRuntimeCredentials } from "@/lib/runtime-credentials.query";

type Step = "organization" | "app" | "access";
type AppMode = "choose" | "pick" | "create" | "key";

interface ConnectedResult {
  id: string;
  organization: string;
  modelIds: string[];
}

/**
 * Connects GitHub Copilot paid by a GitHub organization, in the same steps
 * and components as the Guardrails GitHub App setup: the organization, then
 * its GitHub App (one already connected, a new one registered on GitHub, or
 * one by its ID and private key), then who may use it.
 */
export function CopilotOrganizationConnectDialog({
  open,
  onOpenChange,
  replace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reconnect this key: its organization is known, so setup starts at the App. */
  replace?: { id: string; organization: string | null } | null;
}) {
  const appName = useAppName();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const { data: canCreateCredentials } = useHasPermissions({
    credential: ["create"],
  });
  const credentials = useRuntimeCredentials(open && !!canReadCredentials);
  const [step, setStep] = useState<Step>(replace ? "app" : "organization");
  const [mode, setMode] = useState<AppMode>("choose");
  const [organizationInput, setOrganizationInput] = useState(
    replace?.organization ?? "",
  );
  const [organization, setOrganization] = useState(replace?.organization ?? "");
  const [pickedId, setPickedId] = useState("");
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  const [result, setResult] = useState<ConnectedResult | null>(null);

  const check = useCheckCopilotGithubOrganization();
  const pending = usePendingCopilotGithubApp(open && !!canCreateCredentials);
  const start = useStartCopilotGithubApp();
  const install = useInstallCopilotGithubApp();
  const discard = useDiscardCopilotGithubApp();
  const fromCredential = useConnectCopilotGithubAppCredential();
  const validate = useValidateExistingCopilotGithubApp();
  const byKey = useConnectExistingCopilotGithubApp();
  const createdApp = pending.data ?? null;

  // An App lives on one GitHub; only those on the organization's can serve it.
  const host = parseGithubAccountInput(organizationInput);
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
          ) === host.api),
    ) ?? [];

  // An App created earlier still awaits installation: pick up where setup stopped.
  useEffect(() => {
    if (!createdApp || replace) return;
    setOrganization(createdApp.account);
    setOrganizationInput(createdApp.accountUrl);
    setMode("create");
    setStep((current) => (current === "organization" ? "app" : current));
  }, [createdApp, replace]);

  // The return tab reports back once GitHub finishes each step.
  const onSetupStep = useRef<(done: "created" | "installed") => void>(() => {});
  onSetupStep.current = (done) => {
    if (done === "installed") return checkInstall();
    setWaiting(null);
    pending.refetch();
  };
  useEffect(() => onGithubAppSetup((done) => onSetupStep.current(done)), []);
  // An owner may have to approve the install: keep checking while waiting.
  useEffect(() => {
    if (waiting !== "install") return;
    const timer = setInterval(() => onSetupStep.current("installed"), 5000);
    return () => clearInterval(timer);
  }, [waiting]);

  function connected(value: ConnectedResult) {
    setResult(value);
    setWaiting(null);
    setStep("access");
  }

  function continueFromOrganization() {
    check.mutate(
      { organization: organizationInput },
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
    const tab = openGithubWindow("about:blank");
    setWaiting("create");
    start.mutate(
      { organization: organizationInput || organization },
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
    // The return tab can report the install twice; one check is enough.
    if (install.isPending) return;
    install.mutate(
      {},
      {
        onSuccess: (installed) => {
          if (installed?.status === "installed") connected(installed);
        },
        onError: () => setWaiting(null),
      },
    );
  }

  function usePicked() {
    if (!pickedId) return;
    fromCredential.mutate(
      replace
        ? { credentialId: pickedId, replaceKeyId: replace.id }
        : { credentialId: pickedId, organization: organizationInput },
      {
        onSuccess: (answer) => {
          if (answer?.status === "installed") connected(answer);
        },
      },
    );
  }

  function back() {
    if (step === "app" && mode !== "choose") {
      setMode("choose");
      fromCredential.reset();
      return;
    }
    if (step === "app" && !replace) setStep("organization");
  }

  const needsPermission =
    fromCredential.data?.status === "needs_permission"
      ? fromCredential.data
      : null;
  const keyTarget = replace
    ? { replaceKeyId: replace.id }
    : { organization: organizationInput };

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={replace ? "Reconnect GitHub Copilot" : "Connect GitHub Copilot"}
      description="Connect your enterprise GitHub Copilot plan. Can be shared."
      size="medium"
      bodyClassName="space-y-5"
      footer={
        <>
          {step === "app" && (mode !== "choose" || !replace) ? (
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
            <Button type="button" onClick={() => onOpenChange(false)}>
              <span>Done</span>
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
              disabled={!organizationInput.trim() || check.isPending}
              onClick={continueFromOrganization}
            >
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
        </>
      }
    >
      <SetupStepper
        steps={STEPS.map((entry) => entry.label)}
        current={STEPS.findIndex((entry) => entry.id === step)}
      />

      {step === "organization" ? (
        <OrganizationStep
          value={organizationInput}
          onChange={(value) => {
            check.reset();
            setOrganizationInput(value);
          }}
          error={check.error?.message ?? null}
        />
      ) : null}

      {step === "app" && organization ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Organization</span>
          <AccountChip account={organization} />
        </p>
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
          />
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => setMode("key")}
          >
            <span>Connect an App by its ID and private key</span>
          </Button>
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
          {needsPermission ? (
            <InlineNotice variant="warning">
              <CircleAlert aria-hidden />
              <InlineNoticeBody>
                <span className="font-medium">
                  {`${needsPermission.appName} can't make Copilot requests yet.`}
                </span>
                <InlineNoticeText>
                  {`Add Copilot Requests (Read-only) in its settings; an owner of ${needsPermission.organization} approves the change.`}
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
          ) : null}
          {fromCredential.error ? (
            <ErrorNotice message={fromCredential.error.message} />
          ) : null}
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
              error={install.error?.message}
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
          <CopilotAccessSummary organization={organization} />
        </div>
      ) : null}

      {step === "app" && mode === "key" ? (
        <div className="space-y-4">
          <ConnectAppByKey
            fingerprint={validate.data?.fingerprint ?? null}
            checking={validate.isPending}
            connecting={byKey.isPending}
            error={(byKey.error ?? validate.error)?.message ?? null}
            onChange={() => {
              validate.reset();
              byKey.reset();
            }}
            onCheck={(fields) => validate.mutate({ ...fields, ...keyTarget })}
            onConnect={(fields) =>
              byKey.mutate(
                { ...fields, ...keyTarget },
                { onSuccess: (answer) => answer && connected(answer) },
              )
            }
            connectLabel={replace ? "Replace credentials" : "Connect"}
          />
          <CopilotAccessSummary organization={organization} />
        </div>
      ) : null}

      {step === "access" && result ? <AccessStep result={result} /> : null}
    </StandardDialog>
  );
}

/** Whether the model list holds any Claude or Gemini model. */
export function hasClaudeOrGemini(modelIds: string[]): boolean {
  return modelIds.some((id) => /claude|gemini/i.test(id));
}

const STEPS: { id: Step; label: string }[] = [
  { id: "organization", label: "Organization" },
  { id: "app", label: "GitHub App" },
  { id: "access", label: "Access" },
];

function OrganizationStep(props: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <GithubOrganizationField
      id="copilot-org-login"
      value={props.value}
      onChange={props.onChange}
      error={props.error}
    />
  );
}

/** Where Guardrails shows its App's access: under the ways to get the App. */
function CopilotAccessSummary({ organization }: { organization: string }) {
  return (
    <AccessSummary
      intro={`The App only needs Copilot requests, nothing else in the organization. Requests are paid from ${organization}'s AI credits.`}
      permissions={[{ name: "Copilot requests", access: "Read-only" }]}
    />
  );
}

function AccessStep({ result }: { result: ConnectedResult }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {`Connected. ${result.modelIds.length} ${result.modelIds.length === 1 ? "model" : "models"}:`}
        </p>
        <p className="text-sm text-muted-foreground">
          {result.modelIds.join(", ")}
        </p>
      </div>
      {!hasClaudeOrGemini(result.modelIds) && (
        <InlineNotice variant="neutral">
          <Info aria-hidden />
          <InlineNoticeText>
            {`No Claude or Gemini models. ${result.organization}'s Copilot model policy may have them switched off.`}
          </InlineNoticeText>
        </InlineNotice>
      )}
      <ResourceAccessSection resource="llmProviderApiKey" id={result.id} />
      <InlineNotice variant="info">
        <Info aria-hidden />
        <InlineNoticeText>
          GitHub can't limit a single App. Set a cap in Costs & Limits, or turn
          on Stop usage when budget limit is reached in GitHub billing.
        </InlineNoticeText>
      </InlineNotice>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <InlineNotice variant="error">
      <CircleAlert aria-hidden />
      <InlineNoticeText>{message}</InlineNoticeText>
    </InlineNotice>
  );
}
