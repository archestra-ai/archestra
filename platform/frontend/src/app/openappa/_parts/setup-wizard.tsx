"use client";

import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { WizardFooter } from "@/components/wizard-footer";
import { WizardStepper } from "@/components/wizard-stepper";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  useGuardrailsDeployment,
  useUpdateGuardrailsDeployment,
} from "@/lib/guardrails-deployment.query";
import {
  useGuardrailsPolicy,
  useUpdateGuardrailsPolicy,
  useValidateGuardrailsPolicy,
} from "@/lib/guardrails-policy.query";
import { NextStepsStep } from "./setup-next-steps";
import { withSetupRule } from "./setup-rule";
import {
  draftRule,
  EnableStep,
  IntroStep,
  type RuleDraft,
  RuleStep,
  ToolsStep,
  useSetupServers,
} from "./setup-steps";

const STEPS = [
  { id: "intro", title: "How it works" },
  { id: "tools", title: "Your tools" },
  { id: "rule", title: "First rule" },
  { id: "enable", title: "Review" },
  { id: "next", title: "Next steps" },
] as const;
type StepId = (typeof STEPS)[number]["id"];
type ReviewSnapshot = {
  baseContent: string;
  content: string;
  revision: number;
  preview: ReturnType<typeof withSetupRule> | null;
};

/**
 * `/openappa/setup`: a first run through OpenAPPA. It explains the idea, checks
 * there are tools to protect, builds one rule from two picked tools, then saves
 * it and turns enforcement on. Nothing is written before the last step.
 */
export function OpenAppaSetupWizard() {
  const [step, setStep] = useState<StepId>("intro");
  const [draft, setDraft] = useState<RuleDraft>({
    shape: "flow",
    source: null,
    guarded: null,
  });
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [ruleWarnings, setRuleWarnings] = useState<string[]>([]);
  const [reviewed, setReviewed] = useState<ReviewSnapshot | null>(null);
  const [didSaveRule, setDidSaveRule] = useState(false);
  const activeValidation = useRef<ReviewSnapshot | null>(null);
  const currentPolicy = useRef<{ content: string; revision: number } | null>(
    null,
  );
  const body = useRef<HTMLDivElement>(null);

  // Each step opens at its top. The app shell scrolls inside its own
  // containers (the page container from md up, <main> below), not the window.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per step
  useEffect(() => {
    for (let el = body.current?.parentElement; el; el = el.parentElement)
      el.scrollTop = 0;
    window.scrollTo({ top: 0 });
  }, [step]);

  const setup = useSetupServers();
  const policy = useGuardrailsPolicy();
  const deployment = useGuardrailsDeployment();
  const validate = useValidateGuardrailsPolicy();
  const savePolicy = useUpdateGuardrailsPolicy();
  const enable = useUpdateGuardrailsDeployment();
  const { data: canSavePolicy } = useHasPermissions({
    toolPolicy: ["update"],
  });
  const { data: canEnable } = useHasPermissions({ organization: ["update"] });

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const prevStep = STEPS[stepIndex - 1];
  const nextStep = STEPS[stepIndex + 1];
  const goToStep = (target: StepId) => {
    // Keep the review step available for enable retries after the rule saves.
    if (
      (didSaveRule || savePolicy.isPending || enable.isPending) &&
      target !== "next"
    )
      return;
    if (step === "enable" && target !== "next") {
      setReviewed(null);
      setValidationErrors([]);
      setRuleWarnings([]);
    }
    setStep(target);
  };

  const rule = draftRule(draft);
  const candidate =
    rule && policy.data ? withSetupRule(policy.data.content, rule) : null;
  currentPolicy.current = policy.data
    ? { content: policy.data.content, revision: policy.data.revision }
    : null;
  const skippedRule = reviewed?.preview === null;
  const ruleNeedsSave = Boolean(
    reviewed?.preview && reviewed.content !== reviewed.baseContent,
  );
  const reviewPolicy = reviewed
    ? {
        content: reviewed.content,
        added:
          ruleNeedsSave && !didSaveRule ? reviewed.preview?.added : undefined,
      }
    : null;
  const alreadyOn = deployment.data?.enabled === true;
  const saving = savePolicy.isPending || enable.isPending;
  const busy = saving || validate.isPending;
  const policyChanged =
    reviewed &&
    !didSaveRule &&
    (!policy.data ||
      policy.data.revision !== reviewed.revision ||
      policy.data.content !== reviewed.baseContent);
  const blockedBy = policyChanged
    ? "The policy changed since validation. Go back and review it again."
    : skippedRule && validationErrors.length > 0
      ? "Fix the policy validation errors before turning on OpenAPPA."
      : ruleNeedsSave && !didSaveRule && !canSavePolicy
        ? "Saving a rule needs permission to update the tool policy."
        : !alreadyOn && !canEnable
          ? "Only administrators can turn OpenAPPA on."
          : null;

  const checkForReview = (snapshot: ReviewSnapshot) => {
    // Validate the exact policy the review step will use.
    setValidationErrors([]);
    setRuleWarnings([]);
    activeValidation.current = snapshot;
    validate.mutate(snapshot.content, {
      onSuccess: (result) => {
        const latest = currentPolicy.current;
        if (
          activeValidation.current !== snapshot ||
          latest?.revision !== snapshot.revision ||
          latest.content !== snapshot.baseContent
        )
          return;
        activeValidation.current = null;
        setRuleWarnings(result?.warnings ?? []);
        if (result?.valid || snapshot.preview === null) {
          setReviewed(snapshot);
          if (!result?.valid) setValidationErrors(result?.errors ?? []);
          goToStep("enable");
        } else setValidationErrors(result?.errors ?? []);
      },
    });
  };

  const next = () => {
    if (step !== "rule" || !candidate) {
      if (nextStep) goToStep(nextStep.id);
      return;
    }
    if (!policy.data) return;
    checkForReview({
      baseContent: policy.data.content,
      content: candidate.content,
      revision: policy.data.revision,
      preview: candidate,
    });
  };

  const finish = () => {
    const turnOn = () => {
      if (alreadyOn) goToStep("next");
      else enable.mutate(true, { onSuccess: () => goToStep("next") });
    };
    if (!reviewed || policyChanged) return;
    if (didSaveRule || !reviewed.preview) return turnOn();
    // Another visit can find this rule already in the saved policy.
    if (reviewed.content === reviewed.baseContent) return turnOn();
    savePolicy.mutate(
      {
        content: reviewed.content,
        expectedRevision: reviewed.revision,
      },
      {
        onSuccess: () => {
          setDidSaveRule(true);
          turnOn();
        },
      },
    );
  };

  const nextDisabled =
    (step === "tools" && setup.catalogs.length === 0) ||
    (step === "rule" && (!candidate || validate.isPending));

  return (
    <PageLayout
      maxWidth="wizard"
      minWidth="phone"
      contentOverflowX="clip"
      title="Set up OpenAPPA"
      description="Learn the idea, write a first rule, turn it on."
      backLink={<PageBackLink href="/openappa">OpenAPPA</PageBackLink>}
      actionButton={
        <div className="hidden sm:block">
          <WizardStepper
            compact
            steps={STEPS}
            activeStep={step}
            onStepClick={(target) => {
              // The review step must stay put while saving and after a save.
              if (
                step !== "next" &&
                !busy &&
                !didSaveRule &&
                STEPS.findIndex((s) => s.id === target) < stepIndex
              )
                goToStep(target);
            }}
          />
        </div>
      }
    >
      <div ref={body} className="flex min-h-[calc(100dvh-14rem)] flex-col">
        <div
          key={step}
          className="flex-1 pb-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
        >
          {step === "intro" && <IntroStep />}
          {step === "tools" && <ToolsStep setup={setup} />}
          {step === "rule" && (
            <RuleStep
              catalogs={setup.catalogs}
              draft={draft}
              policy={policy.data?.content ?? ""}
              onChange={(next) => {
                activeValidation.current = null;
                setDraft(next);
                setValidationErrors([]);
                setRuleWarnings([]);
              }}
              errors={validationErrors}
            />
          )}
          {step === "enable" && (
            <EnableStep
              draft={ruleNeedsSave && !didSaveRule ? draft : null}
              alreadyOn={alreadyOn}
              policy={reviewPolicy}
              notice={
                <div className="space-y-3">
                  {ruleWarnings.length > 0 && (
                    <InlineNotice variant="neutral">
                      <span className="font-medium">
                        Policy validation warnings
                      </span>
                      <InlineNoticeText className="whitespace-pre-wrap font-mono">
                        {ruleWarnings.join("\n")}
                      </InlineNoticeText>
                    </InlineNotice>
                  )}
                  {didSaveRule && !alreadyOn && (
                    <InlineNotice variant="info">
                      <InlineNoticeText>
                        Your rule was saved. OpenAPPA is still off. Try turning
                        it on again.
                      </InlineNoticeText>
                    </InlineNotice>
                  )}
                  {skippedRule && validationErrors.length > 0 && (
                    <InlineNotice variant="error">
                      <span className="font-medium">
                        Policy validation errors
                      </span>
                      <InlineNoticeText className="whitespace-pre-wrap font-mono">
                        {validationErrors.join("\n")}
                      </InlineNoticeText>
                    </InlineNotice>
                  )}
                  {blockedBy && (
                    <InlineNotice variant="warning">
                      <span className="font-medium">
                        You cannot finish this step.
                      </span>
                      <InlineNoticeText>{blockedBy}</InlineNoticeText>
                    </InlineNotice>
                  )}
                </div>
              }
            />
          )}
          {step === "next" && (
            <NextStepsStep draft={ruleNeedsSave ? draft : null} />
          )}
        </div>
        <WizardFooter>
          <div>
            {step === "next" ? null : prevStep ? (
              <Button
                variant="outline"
                disabled={busy || didSaveRule}
                onClick={() => goToStep(prevStep.id)}
              >
                <ArrowLeft />
                <span>{prevStep.title}</span>
              </Button>
            ) : (
              <Button variant="outline" asChild>
                <Link href="/openappa">Cancel</Link>
              </Button>
            )}
          </div>
          <div className="gap-2">
            {step === "rule" && (
              <Button
                variant="ghost"
                disabled={!policy.data || validate.isPending}
                onClick={() => {
                  if (!policy.data) return;
                  checkForReview({
                    baseContent: policy.data.content,
                    content: policy.data.content,
                    revision: policy.data.revision,
                    preview: null,
                  });
                }}
              >
                Skip for now
              </Button>
            )}
            {step === "next" ? (
              <Button key="done" asChild>
                <Link href="/openappa">Go to OpenAPPA</Link>
              </Button>
            ) : step === "enable" ? (
              <Button
                key="finish"
                disabled={saving || Boolean(blockedBy) || deployment.isPending}
                onClick={finish}
              >
                {saving && <Loader2 className="animate-spin" />}
                <span>
                  {alreadyOn
                    ? ruleNeedsSave && !didSaveRule
                      ? "Save rule"
                      : "Continue"
                    : ruleNeedsSave && !didSaveRule
                      ? "Save and turn on"
                      : "Turn on"}
                </span>
              </Button>
            ) : (
              nextStep && (
                <Button key="next" disabled={nextDisabled} onClick={next}>
                  {validate.isPending && <Loader2 className="animate-spin" />}
                  <span>{nextStep.title}</span>
                  <ArrowRight />
                </Button>
              )
            )}
          </div>
        </WizardFooter>
      </div>
    </PageLayout>
  );
}
