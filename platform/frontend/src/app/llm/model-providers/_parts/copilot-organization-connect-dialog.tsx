"use client";

import { Check, CircleAlert, Info, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConnectionSignInDialog } from "@/components/connection-sign-in-dialog";
import { GitHubConnectButton } from "@/components/github-connect-button";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  useCheckCopilotGithubOrganization,
  useCompleteCopilotGithubApp,
  useConnectExistingCopilotGithubApp,
  useDiscardCopilotGithubApp,
  useInstallCopilotGithubApp,
  usePendingCopilotGithubApp,
  useStartCopilotGithubApp,
  useValidateExistingCopilotGithubApp,
} from "@/lib/github-copilot-app.query";
import { onCopilotAppSetup } from "./copilot-organization-channel";

type Step = "start" | "install" | "existing" | "result";

interface ConnectedResult {
  id: string;
  organization: string;
  modelIds: string[];
}

/**
 * Connects GitHub Copilot paid by a GitHub organization. The guided path
 * registers a GitHub App from a manifest on the organization and installs it;
 * the other path takes an existing App. Both end on the models it reaches and
 * who may use it.
 */
export function CopilotOrganizationConnectDialog({
  open,
  onOpenChange,
  replace,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Replace the App credentials of this key instead of connecting a new one. */
  replace?: { id: string; organization: string | null } | null;
}) {
  const [step, setStep] = useState<Step>(replace ? "existing" : "start");
  const [organization, setOrganization] = useState(replace?.organization ?? "");
  const [waiting, setWaiting] = useState<"create" | "install" | null>(null);
  const [result, setResult] = useState<ConnectedResult | null>(null);

  const pending = usePendingCopilotGithubApp(open && !replace);
  const checkOrganization = useCheckCopilotGithubOrganization();
  const start = useStartCopilotGithubApp();
  const complete = useCompleteCopilotGithubApp();
  const install = useInstallCopilotGithubApp();
  const discard = useDiscardCopilotGithubApp();
  const createdApp = pending.data ?? complete.data ?? null;

  useEffect(() => {
    if (!open) return;
    setStep(replace ? "existing" : "start");
    setOrganization(replace?.organization ?? "");
    setResult(null);
    setWaiting(null);
  }, [open, replace]);

  // Resume a setup whose App already exists on GitHub.
  useEffect(() => {
    if (createdApp && step === "start") {
      setOrganization(createdApp.organization);
      setStep("install");
    }
  }, [createdApp, step]);

  // The return tab reports back once GitHub finishes each step.
  const onSetupStep = useRef<(done: "created" | "installed") => void>(() => {});
  onSetupStep.current = (done) => {
    if (done === "installed") return checkInstall();
    setWaiting(null);
    pending.refetch();
  };
  useEffect(() => onCopilotAppSetup((done) => onSetupStep.current(done)), []);

  // While waiting on an install (an owner may have to approve it), poll.
  useEffect(() => {
    if (waiting !== "install") return;
    const timer = setInterval(() => onSetupStep.current("installed"), 5000);
    return () => clearInterval(timer);
  }, [waiting]);

  function createApp() {
    const login = organization.trim();
    if (!login) return;
    // Open the tab inside the click so the browser does not block it.
    const tab = window.open("about:blank", GITHUB_WINDOW);
    setWaiting("create");
    start.mutate(
      { organization: login },
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

  function openInstall() {
    if (!createdApp) return;
    install.reset();
    window.open(createdApp.installUrl, GITHUB_WINDOW);
    setWaiting("install");
  }

  function checkInstall() {
    // The return tab can report the install twice; one check is enough.
    if (install.isPending) return;
    install.mutate(
      {},
      {
        onSuccess: (installed) => {
          if (installed?.status !== "installed") return;
          setWaiting(null);
          setResult(installed);
          setStep("result");
        },
        onError: () => setWaiting(null),
      },
    );
  }

  const title = replace ? "Reconnect GitHub Copilot" : "Connect GitHub Copilot";

  return (
    <ConnectionSignInDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Connect your enterprise GitHub Copilot plan. Can be shared."
      action={
        step === "start" ? (
          <StartStep
            organization={organization}
            onOrganizationChange={(value) => {
              start.reset();
              checkOrganization.reset();
              setOrganization(value);
            }}
            error={(start.error ?? checkOrganization.error)?.message ?? null}
            creating={waiting === "create"}
            onCreate={createApp}
            checking={checkOrganization.isPending}
            onUseExisting={() =>
              // The existing App uses this organization, so check it first
              // just as Create the App on GitHub does.
              checkOrganization.mutate(
                { organization },
                { onSuccess: () => setStep("existing") },
              )
            }
          />
        ) : step === "install" ? (
          <InstallStep
            name={createdApp?.name ?? null}
            organization={createdApp?.organization ?? organization}
            waiting={waiting === "install"}
            error={install.error?.message ?? null}
            canInstall={!!createdApp}
            onInstall={openInstall}
            onStartOver={() => {
              discard.mutate();
              complete.reset();
              setWaiting(null);
              setStep("start");
            }}
          />
        ) : step === "existing" ? (
          <ExistingAppStep
            organization={replace ? undefined : organization}
            replaceKeyId={replace?.id}
            onBack={replace ? undefined : () => setStep("start")}
            onConnected={(connected) => {
              setResult(connected);
              setStep("result");
            }}
          />
        ) : result ? (
          <ResultStep result={result} onDone={() => onOpenChange(false)} />
        ) : null
      }
    />
  );
}

/** Whether the model list holds any Claude or Gemini model. */
export function hasClaudeOrGemini(modelIds: string[]): boolean {
  return modelIds.some((id) => /claude|gemini/i.test(id));
}

function StartStep(props: {
  organization: string;
  onOrganizationChange: (value: string) => void;
  error: string | null;
  creating: boolean;
  onCreate: () => void;
  checking: boolean;
  onUseExisting: () => void;
}) {
  const organizationLabel =
    displayOrganization(props.organization) || "the organization";
  const fieldError =
    props.error && isOrganizationError(props.error) ? props.error : null;
  return (
    <div className="space-y-4">
      <OrganizationField
        id="copilot-org-login"
        value={props.organization}
        onChange={props.onOrganizationChange}
        error={fieldError}
      />
      <div className="space-y-2">
        <p className="text-sm font-medium">What this allows</p>
        <ul className="space-y-1.5 text-sm">
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <span>{`Make Copilot requests, paid from ${organizationLabel}'s AI credits`}</span>
          </li>
          <li className="flex items-start gap-2 text-muted-foreground">
            <X className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Read code, repositories, issues or members</span>
          </li>
        </ul>
      </div>
      {props.error && !fieldError && <ErrorNotice message={props.error} />}
      <div className="flex flex-wrap items-center gap-2">
        <GitHubConnectButton
          label="Create the App on GitHub"
          pending={props.creating}
          disabled={!props.organization.trim()}
          onClick={props.onCreate}
        />
        <Button
          variant="link"
          size="sm"
          disabled={props.checking}
          onClick={props.onUseExisting}
        >
          <span>Use an existing App</span>
        </Button>
      </div>
    </div>
  );
}

function InstallStep(props: {
  name: string | null;
  organization: string;
  waiting: boolean;
  error: string | null;
  canInstall: boolean;
  onInstall: () => void;
  onStartOver: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {props.name
          ? `${props.name} was created. Install it on ${props.organization} to finish.`
          : `Install the App on ${props.organization} to finish.`}
      </p>
      <p className="text-sm text-muted-foreground">
        {`If you're not an owner of ${props.organization}, GitHub sends the request to an owner. This finishes once they approve.`}
      </p>
      {props.waiting && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          Waiting for the installation...
        </p>
      )}
      {props.error && <ErrorNotice message={props.error} />}
      <div className="flex flex-wrap items-center gap-2">
        <GitHubConnectButton
          label={`Install on ${props.organization}`}
          disabled={!props.canInstall}
          onClick={props.onInstall}
        />
        <Button variant="ghost" size="sm" onClick={props.onStartOver}>
          <span>Start over</span>
        </Button>
      </div>
    </div>
  );
}

function ExistingAppStep(props: {
  /** What was entered on the first step; absent when reconnecting a key. */
  organization?: string;
  replaceKeyId?: string;
  onBack?: () => void;
  onConnected: (result: ConnectedResult) => void;
}) {
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const validate = useValidateExistingCopilotGithubApp();
  const connect = useConnectExistingCopilotGithubApp();
  // Reconnecting a key, the backend uses the organization stored on it.
  const fields =
    appId.trim() && privateKey
      ? {
          appId: appId.trim(),
          privateKey,
          ...(props.replaceKeyId
            ? { replaceKeyId: props.replaceKeyId }
            : { organization: props.organization?.trim() }),
        }
      : null;

  async function readFile(file: File | undefined) {
    if (!file) return;
    validate.reset();
    setFileName(file.name);
    // The key is held for the request only; it is never rendered.
    setPrivateKey(await file.text());
  }

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="copilot-existing-app-id">App ID</Label>
          <Input
            id="copilot-existing-app-id"
            inputMode="numeric"
            value={appId}
            onChange={(event) => {
              validate.reset();
              setAppId(event.target.value);
            }}
          />
        </div>
      </div>
      {props.organization && (
        <p className="text-sm text-muted-foreground">
          {`Organization: ${displayOrganization(props.organization)}`}
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor="copilot-existing-key">Private key</Label>
        <UnstyledButton
          className={`flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-sm text-muted-foreground ${dragging ? "border-primary bg-muted/40" : ""}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void readFile(event.dataTransfer.files[0]);
          }}
        >
          <Upload className="h-4 w-4" />
          <span>
            {fileName
              ? `${fileName} added`
              : "Drop the .pem file from the App settings, or choose it"}
          </span>
        </UnstyledButton>
        <input
          ref={fileInput}
          id="copilot-existing-key"
          type="file"
          accept=".pem,application/x-pem-file"
          className="sr-only"
          onChange={(event) => void readFile(event.target.files?.[0])}
        />
        {validate.data && (
          <p className="text-sm text-muted-foreground">
            <span>Key fingerprint: </span>
            <code className="break-all">{validate.data.fingerprint}</code>
          </p>
        )}
      </div>
      {(validate.error || connect.error) && (
        <ErrorNotice
          message={(connect.error ?? validate.error)?.message ?? ""}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {props.onBack && (
          <Button variant="ghost" size="sm" onClick={props.onBack}>
            <span>Back</span>
          </Button>
        )}
        {validate.data ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!fields || connect.isPending}
            onClick={() =>
              fields &&
              connect.mutate(fields, {
                onSuccess: (connected) =>
                  connected && props.onConnected(connected),
              })
            }
          >
            <span>
              {connect.isPending
                ? "Connecting..."
                : props.replaceKeyId
                  ? "Replace credentials"
                  : "Connect"}
            </span>
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={!fields || validate.isPending}
            onClick={() => fields && validate.mutate(fields)}
          >
            <span>{validate.isPending ? "Checking..." : "Check App"}</span>
          </Button>
        )}
      </div>
    </div>
  );
}

function ResultStep({
  result,
  onDone,
}: {
  result: ConnectedResult;
  onDone: () => void;
}) {
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
      <Button variant="outline" size="sm" onClick={onDone}>
        <span>Done</span>
      </Button>
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

const GITHUB_WINDOW = "github-copilot-app";

/**
 * The one organization input: a name on github.com, or the organization's
 * address on any GitHub host. The backend parses it and says what is wrong.
 */
function OrganizationField({
  id,
  value,
  onChange,
  error,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>GitHub organization</Label>
      <Input
        id={id}
        placeholder="my-org or https://github.com/my-org"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        Organization's GitHub handle or URL
      </p>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Messages about the organization input itself, shown under the field. */
function isOrganizationError(message: string): boolean {
  return (
    message.startsWith("Enter an organization name") ||
    message.startsWith("GitHub Copilot needs an organization") ||
    message.startsWith("GitHub has no account named") ||
    message.startsWith("The App isn't installed on")
  );
}

/** The organization's name for copy, from a name or an address. */
function displayOrganization(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes("/")) return trimmed;
  return (
    trimmed
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
      .split("/")
      .filter(Boolean)[1] ?? ""
  );
}
