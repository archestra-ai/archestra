"use client";

import type { GitProvider } from "@archestra/shared";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { GitAccessStep } from "./git-access-step";
import { GitProviderStep } from "./git-provider-step";
import {
  EMPTY_GIT_REPOSITORY,
  GitRepositoryStep,
  type GitRepositoryValue,
} from "./git-repository-step";
import { SetupStepper } from "./git-setup-chrome";
import {
  type GitAccess,
  gitAuthFields,
  type ResolvedGitRepository,
  resolveGitRepository,
} from "./git-source";

export type GitSourceStep = "provider" | "access" | "repo";

/**
 * The provider → access → repository steps every Git import walks through,
 * before its own last step (pick skills, pick plugins). The dialog owns the
 * footer; this owns the state and what each step shows.
 */
export function useGitSourceSteps() {
  const [step, setStep] = useState<GitSourceStep>("provider");
  const [provider, setProvider] = useState<GitProvider>("github");
  const [access, setAccess] = useState<GitAccess | null>(null);
  const [repository, setRepository] =
    useState<GitRepositoryValue>(EMPTY_GIT_REPOSITORY);

  const resolved: ResolvedGitRepository = access
    ? resolveGitRepository({
        provider,
        access,
        input: repository.input,
        ref: repository.ref,
        subpath: repository.subpath,
      })
    : { ok: false, error: null };

  const pickProvider = useCallback(
    (next: GitProvider) => {
      // A credential belongs to one provider; switching drops it.
      if (next !== provider) {
        setAccess(null);
        setRepository(EMPTY_GIT_REPOSITORY);
      }
      setProvider(next);
      setStep("access");
    },
    [provider],
  );

  /** Open on a public github.com repository (the skill and plugin indexes). */
  const startOnPublicGithub = useCallback((repoUrl: string) => {
    setProvider("github");
    setAccess({ kind: "public" });
    setRepository({ ...EMPTY_GIT_REPOSITORY, input: repoUrl });
    setStep("repo");
  }, []);

  /**
   * Open an existing source to edit: its host stays, its access and
   * repository are filled in. Without a known access it starts there.
   */
  const startEditing = useCallback(
    (params: {
      provider: GitProvider;
      access: GitAccess | null;
      repository: GitRepositoryValue;
    }) => {
      setProvider(params.provider);
      setAccess(params.access);
      setRepository(params.repository);
      setStep(params.access ? "repo" : "access");
    },
    [],
  );

  const reset = useCallback(() => {
    setStep("provider");
    setProvider("github");
    setAccess(null);
    setRepository(EMPTY_GIT_REPOSITORY);
  }, []);

  return {
    step,
    setStep,
    provider,
    pickProvider,
    access,
    setAccess,
    repository,
    setRepository,
    resolved,
    /** Provider and credential fields for the import routes. */
    auth: access ? gitAuthFields({ provider, access }) : { provider },
    back: () => setStep(step === "repo" ? "access" : "provider"),
    startOnPublicGithub,
    startEditing,
    reset,
  };
}

export type GitSourceSteps = ReturnType<typeof useGitSourceSteps>;

/** The labels of the stepper, ending with the feature's own step. */
export function gitSourceStepLabels(params: {
  provider: GitProvider;
  last: string;
}) {
  return [
    "Host",
    "Access",
    params.provider === "gitlab" ? "Project" : "Repository",
    params.last,
  ];
}

export const GIT_SOURCE_STEP_INDEX: Record<GitSourceStep, number> = {
  provider: 0,
  access: 1,
  repo: 2,
};

/** A short line under the dialog title for each source step. */
export function gitSourceStepDescription(params: {
  step: GitSourceStep;
  provider: GitProvider;
}) {
  if (params.step === "provider") return "Where does the repository live?";
  if (params.step === "access")
    return params.provider === "gitlab"
      ? "Use a GitLab token, or read a public project."
      : "Use a GitHub App, or read a public repository.";
  return params.provider === "gitlab"
    ? "Pick or paste the project."
    : "Pick or paste the repository.";
}

/** The stepper and the body of the current source step. */
export function GitSourceStepBody({
  source,
  lastLabel,
  withSubpath = false,
  subpathPlaceholder,
}: {
  source: GitSourceSteps;
  lastLabel: string;
  withSubpath?: boolean;
  subpathPlaceholder?: string;
}) {
  return (
    <div className="space-y-5">
      <SetupStepper
        steps={gitSourceStepLabels({
          provider: source.provider,
          last: lastLabel,
        })}
        current={GIT_SOURCE_STEP_INDEX[source.step]}
      />
      {source.step === "provider" ? (
        <GitProviderStep onPick={source.pickProvider} />
      ) : null}
      {source.step === "access" ? (
        <GitAccessStep
          provider={source.provider}
          access={source.access}
          onAccessChange={source.setAccess}
        />
      ) : null}
      {source.step === "repo" && source.access ? (
        <GitRepositoryStep
          provider={source.provider}
          access={source.access}
          value={source.repository}
          onChange={source.setRepository}
          onChangeAccess={() => source.setStep("access")}
          withSubpath={withSubpath}
          subpathPlaceholder={subpathPlaceholder}
        />
      ) : null}
    </div>
  );
}

/**
 * Back / Cancel / Continue for the source steps. On the repository step the
 * primary action is the feature's (Find skills, Find plugins).
 */
export function GitSourceStepFooter({
  source,
  onCancel,
  findLabel,
  finding,
  onFind,
}: {
  source: GitSourceSteps;
  onCancel: () => void;
  findLabel: string;
  finding: boolean;
  onFind: () => void;
}) {
  return (
    <>
      {source.step !== "provider" ? (
        <Button
          type="button"
          variant="ghost"
          className="mr-auto"
          onClick={source.back}
        >
          <ArrowLeft />
          <span>Back</span>
        </Button>
      ) : null}
      <Button type="button" variant="outline" onClick={onCancel}>
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
      ) : null}
      {source.step === "repo" ? (
        <Button
          type="button"
          disabled={!source.resolved.ok || finding}
          onClick={onFind}
        >
          {finding ? <LoaderCircle className="animate-spin" /> : null}
          <span>{finding ? "Scanning…" : findLabel}</span>
        </Button>
      ) : null}
    </>
  );
}
