"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  useOnboardingSurveyStatus,
  useSubmitOnboardingSurvey,
} from "@/lib/onboarding/onboarding-survey.query";
import { cn } from "@/lib/utils";

/**
 * Renders the one-time onboarding survey when it's due: an admin on a fresh
 * org (the status endpoint already excludes answered/enterprise/non-empty).
 * Mount once at the app shell.
 */
export function OnboardingSurveyGate() {
  const isAuthenticated = useIsAuthenticated();
  // Only admins are surveyed; `member:create` is admin-only.
  const { data: isAdmin } = useHasPermissions({ member: ["create"] });
  const { data: needsSubmission } = useOnboardingSurveyStatus({
    enabled: isAuthenticated && !!isAdmin,
  });

  if (!isAuthenticated || !isAdmin || !needsSubmission) return null;
  return <OnboardingSurveyDialog />;
}

/** Sentinel radio value that reveals a free-text "Other" input. */
const OTHER = "__other__";

type QuestionId = "role" | "workEnvironment" | "referralSource";

const QUESTIONS: { id: QuestionId; label: string; options: string[] }[] = [
  {
    id: "role",
    label: "What do you do?",
    options: ["Software engineer", "SRE", "AI Team"],
  },
  {
    id: "workEnvironment",
    label: "Where do you spend your days?",
    options: ["Startup", "Enterprise", "Studying / between things"],
  },
  {
    id: "referralSource",
    label: "How'd you find us?",
    options: [
      "GitHub",
      "Reddit",
      "YouTube",
      "Colleagues / Friends",
      "Conference",
    ],
  },
];

/**
 * One-time, non-dismissable "getting to know you" survey. The parent decides
 * when to render it (fresh org + admin); on successful submit the mutation
 * clears the "needs submission" state and the parent unmounts this.
 */
export function OnboardingSurveyDialog() {
  const { data: session } = useSession();
  const submit = useSubmitOnboardingSurvey();

  const [selected, setSelected] = React.useState<Record<QuestionId, string>>({
    role: "",
    workEnvironment: "",
    referralSource: "",
  });
  const [other, setOther] = React.useState<Record<QuestionId, string>>({
    role: "",
    workEnvironment: "",
    referralSource: "",
  });
  const [workEmail, setWorkEmail] = React.useState("");

  // Prefill the contact email from the signed-in account once it loads.
  const accountEmail = session?.user?.email ?? "";
  React.useEffect(() => {
    if (accountEmail) setWorkEmail((current) => current || accountEmail);
  }, [accountEmail]);

  const resolve = (id: QuestionId): string =>
    selected[id] === OTHER ? other[id].trim() : selected[id];

  const answers = {
    role: resolve("role"),
    workEnvironment: resolve("workEnvironment"),
    referralSource: resolve("referralSource"),
  };
  const canSubmit =
    !!answers.role &&
    !!answers.workEnvironment &&
    !!answers.referralSource &&
    !submit.isPending;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmedEmail = workEmail.trim();
    submit.mutate({
      ...answers,
      workEmail: trimmedEmail ? trimmedEmail : null,
    });
  };

  const preventDismiss = (event: Event) => event.preventDefault();

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        className="flex max-w-md flex-col gap-0 rounded-2xl p-0"
        onEscapeKeyDown={preventDismiss}
        onPointerDownOutside={preventDismiss}
        onInteractOutside={preventDismiss}
      >
        <form
          onSubmit={handleSubmit}
          className="flex min-h-0 flex-col overflow-hidden"
        >
          <div className="shrink-0 px-7 pt-7 pb-3">
            <DialogTitle className="text-lg font-semibold tracking-tight">
              Welcome to Archestra
            </DialogTitle>
            <DialogDescription className="text-muted-foreground mt-1 text-sm">
              A few quick questions — takes about 20 seconds.
            </DialogDescription>
          </div>

          <div className="flex-1 overflow-y-auto px-7">
            {QUESTIONS.map((question, index) => (
              <div
                key={question.id}
                className={cn("py-5", index > 0 && "border-border/60 border-t")}
              >
                <Label
                  htmlFor={`survey-${question.id}`}
                  className="mb-2 block text-sm font-medium"
                >
                  {question.label}
                </Label>
                <Select
                  value={selected[question.id]}
                  onValueChange={(value) =>
                    setSelected((prev) => ({ ...prev, [question.id]: value }))
                  }
                >
                  <SelectTrigger
                    id={`survey-${question.id}`}
                    className="h-9 w-full"
                  >
                    <SelectValue placeholder="Select one…" />
                  </SelectTrigger>
                  <SelectContent>
                    {question.options.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                    <SelectItem value={OTHER}>Other</SelectItem>
                  </SelectContent>
                </Select>
                {selected[question.id] === OTHER && (
                  <Input
                    autoFocus
                    placeholder="Tell us more"
                    value={other[question.id]}
                    onChange={(event) =>
                      setOther((prev) => ({
                        ...prev,
                        [question.id]: event.target.value,
                      }))
                    }
                    className="mt-2 h-9"
                  />
                )}
              </div>
            ))}

            <div className="border-border/60 border-t py-5">
              <Label
                htmlFor="survey-work-email"
                className="text-sm font-medium"
              >
                Work email
                <span className="text-muted-foreground ml-1.5 font-normal">
                  optional, to hear from us
                </span>
              </Label>
              <Input
                id="survey-work-email"
                type="email"
                placeholder="you@company.com"
                value={workEmail}
                onChange={(event) => setWorkEmail(event.target.value)}
                className="mt-2.5 h-9"
              />
            </div>
          </div>

          <div className="shrink-0 px-7 pt-4 pb-7">
            <Button
              type="submit"
              disabled={!canSubmit}
              className="h-10 w-full rounded-lg"
            >
              {submit.isPending ? "Saving…" : "Continue"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
