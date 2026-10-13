"use client";

import {
  type GitProvider,
  gitHostFromUrl,
  gitWebUrls,
} from "@archestra/shared";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useGitCredentials } from "@/lib/git-credentials.query";
import { GitAccessStep } from "./git-access-step";
import { GitRepositoryStep } from "./git-repository-step";
import { SetupStepper } from "./git-setup-chrome";
import type { ResolvedGitRepository } from "./git-source";
import {
  GIT_SOURCE_STEP_INDEX,
  gitSourceStepDescription,
  useGitSourceSteps,
} from "./git-source-steps";

export type GitSyncInterval = "15m" | "1h" | "1d";

export const GIT_SYNC_INTERVAL_LABELS: Record<GitSyncInterval, string> = {
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "1d": "Once a day",
};

export interface GitSourceEditValue {
  /** Provider and credential fields for the Git routes. */
  auth: ReturnType<typeof useGitSourceSteps>["auth"];
  repository: Extract<ResolvedGitRepository, { ok: true }>;
  /** null: checked only when asked. */
  interval: GitSyncInterval | null;
}

/**
 * Edit where something syncs from with the steps that set it up: access, then
 * repository with its branch and folder, then how often to check. The host
 * stays: a source moves within its Git host, never across.
 */
export function GitSourceEditDialog({
  name,
  current,
  withSubpath = false,
  subpathPlaceholder,
  allowManual = false,
  syncDescription,
  saving,
  onSave,
  onOpenChange,
}: {
  /** What syncs: "style-guide", "ab-dev". */
  name: string;
  current: {
    provider: GitProvider;
    /** The host's web address; null on the public cloud. */
    origin: string | null;
    /** `owner/repo` or `group/sub/project`. */
    repo: string;
    ref: string | null;
    subpath: string;
    credentialId: string | null;
    interval: GitSyncInterval | null;
  };
  withSubpath?: boolean;
  subpathPlaceholder?: string;
  /** Offer checking only when asked, as well as a schedule. */
  allowManual?: boolean;
  /** What a new commit does, under the schedule. */
  syncDescription: string;
  saving: boolean;
  /** Resolves true once saved, closing the dialog. */
  onSave: (value: GitSourceEditValue) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
}) {
  const source = useGitSourceSteps();
  const { data: canReadCredentials } = useHasPermissions({
    credential: ["read"],
  });
  const credentials = useGitCredentials(canReadCredentials === true);
  // Without the permission the list never loads: start without it.
  const credentialsReady =
    canReadCredentials === false || !credentials.isPending;
  const [interval, setInterval] = useState<GitSyncInterval | typeof MANUAL>(
    current.interval ?? MANUAL,
  );
  // Fill the steps in once, when the saved credentials are known.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !credentialsReady) return;
    started.current = true;
    const credential = current.credentialId
      ? credentials.data?.find((entry) => entry.id === current.credentialId)
      : null;
    source.startEditing({
      provider: current.provider,
      // A credential this reader can't see is chosen again, not guessed.
      access: credential
        ? { kind: "credential", credential }
        : current.credentialId
          ? null
          : { kind: "public" },
      repository: {
        input: gitWebUrls({
          host: gitHostFromUrl({
            provider: current.provider,
            url: current.origin,
          }),
          path: current.repo,
        }).repo,
        // As if pasted: it shows whether or not the credential lists it.
        picked: false,
        ref: current.ref ?? "",
        subpath: current.subpath,
      },
    });
  }, [credentialsReady, credentials.data, current, source]);

  const resolved = source.resolved;
  const save = async () => {
    if (!resolved.ok) return;
    const saved = await onSave({
      auth: source.auth,
      repository: resolved,
      interval: interval === MANUAL ? null : interval,
    });
    if (saved) onOpenChange(false);
  };

  return (
    <StandardDialog
      open
      onOpenChange={onOpenChange}
      title="Edit source"
      description={
        started.current
          ? gitSourceStepDescription({
              step: source.step,
              provider: source.provider,
            })
          : `Where ${name} comes from, and how often it checks for changes.`
      }
      size="medium"
      footer={
        <>
          {source.step === "repo" ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => source.setStep("access")}
            >
              <ArrowLeft />
              <span>Back</span>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            <span>Cancel</span>
          </Button>
          {source.step === "access" ? (
            <Button
              type="button"
              disabled={!source.access}
              onClick={() => source.setStep("repo")}
            >
              <span>Continue</span>
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!resolved.ok || saving}
              onClick={save}
            >
              {saving ? <LoaderCircle className="animate-spin" /> : null}
              <span>{saving ? "Saving…" : "Save"}</span>
            </Button>
          )}
        </>
      }
    >
      {!started.current ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          <span>Loading…</span>
        </div>
      ) : (
        <div className="space-y-5">
          <SetupStepper
            steps={[
              "Host",
              "Access",
              source.provider === "gitlab" ? "Project" : "Repository",
            ]}
            current={GIT_SOURCE_STEP_INDEX[source.step]}
          />
          {source.step === "access" ? (
            <GitAccessStep
              provider={source.provider}
              access={source.access}
              onAccessChange={source.setAccess}
            />
          ) : null}
          {source.step === "repo" && source.access ? (
            <>
              <GitRepositoryStep
                provider={source.provider}
                access={source.access}
                value={source.repository}
                onChange={source.setRepository}
                onChangeAccess={() => source.setStep("access")}
                withSubpath={withSubpath}
                subpathPlaceholder={subpathPlaceholder}
              />
              <div className="space-y-2">
                <Label htmlFor="git-source-interval">Keep in sync</Label>
                <Select
                  value={interval}
                  onValueChange={(value) =>
                    setInterval(value as GitSyncInterval | typeof MANUAL)
                  }
                >
                  <SelectTrigger id="git-source-interval" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {allowManual && (
                      <SelectItem value={MANUAL}>Manual checks</SelectItem>
                    )}
                    {Object.entries(GIT_SYNC_INTERVAL_LABELS).map(
                      ([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
                <FieldDescription>{syncDescription}</FieldDescription>
              </div>
            </>
          ) : null}
        </div>
      )}
    </StandardDialog>
  );
}

const MANUAL = "off";
