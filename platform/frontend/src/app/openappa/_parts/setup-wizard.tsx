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
  const [skipRule, setSkipRule] = useState(false);
  const [ruleErrors, setRuleErrors] = useState<string[]>([]);
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
    // Coming back to the rule step means the rule is wanted again.
    if (target === "rule") setSkipRule(false);
    setStep(target);
  };

  const rule = skipRule ? null : draftRule(draft);
  const saved =
    rule && policy.data ? withSetupRule(policy.data.content, rule) : null;
  const alreadyOn = deployment.data?.enabled === true;
  const saving = savePolicy.isPending || enable.isPending;
  const blockedBy =
    rule && !canSavePolicy
      ? "Saving a rule needs permission to update the tool policy."
      : !alreadyOn && !canEnable
        ? "Only administrators can turn OpenAPPA on."
        : null;

  const next = () => {
    if (step !== "rule" || !rule || !policy.data) {
      if (nextStep) goToStep(nextStep.id);
      return;
    }
    // Checked the way a save checks it, so the last step does not fail late.
    setRuleErrors([]);
    validate.mutate(withSetupRule(policy.data.content, rule).content, {
      onSuccess: (result) => {
        if (result?.valid) goToStep("enable");
        else setRuleErrors(result?.errors ?? []);
      },
    });
  };

  const finish = () => {
    const turnOn = () => {
      if (alreadyOn) goToStep("next");
      else enable.mutate(true, { onSuccess: () => goToStep("next") });
    };
    if (!saved || !policy.data) return turnOn();
    savePolicy.mutate(
      {
        content: saved.content,
        expectedRevision: policy.data.revision,
      },
      { onSuccess: turnOn },
    );
  };

  const nextDisabled =
    (step === "tools" && setup.catalogs.length === 0) ||
    (step === "rule" && (!rule || !policy.data || validate.isPending));

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
              // Once saved, going back would add the rule a second time.
              if (
                step !== "next" &&
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
                setDraft(next);
                setRuleErrors([]);
              }}
              errors={ruleErrors}
            />
          )}
          {step === "enable" && (
            <EnableStep
              draft={rule ? draft : null}
              alreadyOn={alreadyOn}
              policy={
                saved ?? (policy.data ? { content: policy.data.content } : null)
              }
              notice={
                blockedBy ? (
                  <InlineNotice variant="warning">
                    <span className="font-medium">
                      You cannot finish this step.
                    </span>
                    <InlineNoticeText>{blockedBy}</InlineNoticeText>
                  </InlineNotice>
                ) : null
              }
            />
          )}
          {step === "next" && <NextStepsStep draft={rule ? draft : null} />}
        </div>
        <WizardFooter>
          <div>
            {step === "next" ? null : prevStep ? (
              <Button
                variant="outline"
                disabled={saving}
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
                onClick={() => {
                  setSkipRule(true);
                  goToStep("enable");
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
                    ? rule
                      ? "Save rule"
                      : "Continue"
                    : rule
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
