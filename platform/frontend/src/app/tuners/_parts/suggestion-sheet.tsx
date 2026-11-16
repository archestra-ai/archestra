"use client";

import type { Permissions } from "@archestra/shared";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { HunkEditor } from "@/components/version-history/hunk-block";
import {
  type TunerSuggestion,
  type TunerSuggestionAction,
  useTunerSuggestionAction,
} from "@/lib/tuners.query";
import { formatDate } from "@/lib/utils/date-time";
import {
  SEVERITY,
  SOURCE_LABEL,
  STATUS_LABEL,
  TUNER_LABEL,
  VERIFICATION_REASON_LABEL,
} from "./tuner-labels";

/** One suggestion in a right drawer; `onChange` gets its next state, null closes it. */
export function SuggestionSheet({
  suggestion,
  canUpdate,
  onChange,
}: {
  suggestion: TunerSuggestion | null;
  canUpdate: boolean;
  onChange: (suggestion: TunerSuggestion | null) => void;
}) {
  // Keep the last suggestion on screen while the sheet animates out.
  const [shown, setShown] = useState(suggestion);
  if (suggestion !== null && suggestion !== shown) setShown(suggestion);

  return (
    <Sheet
      open={suggestion !== null}
      onOpenChange={(open) => {
        if (!open) onChange(null);
      }}
    >
      <SheetContent side="right" className="w-full gap-0 sm:max-w-[720px]">
        {shown ? (
          <SuggestionDetail
            suggestion={shown}
            canUpdate={canUpdate}
            onChange={onChange}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

// === Internal helpers

type PolicyChange = Extract<
  TunerSuggestion["action"],
  { type: "policy_change" }
>;
type Evidence = TunerSuggestion["evidence"][number];
type CommentAction = "done" | "reject";

function SuggestionDetail({
  suggestion,
  canUpdate,
  onChange,
}: {
  suggestion: TunerSuggestion;
  canUpdate: boolean;
  onChange: (suggestion: TunerSuggestion | null) => void;
}) {
  const action = useTunerSuggestionAction();
  const [commenting, setCommenting] = useState<CommentAction | null>(null);
  const severity = SEVERITY[suggestion.severity];
  const policyChange =
    suggestion.action.type === "policy_change" ? suggestion.action : null;
  // Done and reject take the suggestion out of the inbox, so the drawer closes;
  // apply and refresh keep it open on its new state (e.g. the published PR).
  const act = (variables: TunerSuggestionAction) =>
    action.mutate(variables, {
      onSuccess: (next) => {
        setCommenting(null);
        onChange(
          variables.type === "done" || variables.type === "reject"
            ? null
            : next,
        );
      },
    });

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={severity.variant}>{severity.label}</Badge>
          <Badge variant="outline">{STATUS_LABEL[suggestion.status]}</Badge>
        </div>
        <SheetTitle>{suggestion.title}</SheetTitle>
        <SheetDescription>
          {TUNER_LABEL[suggestion.tunerKind]} ·{" "}
          {SOURCE_LABEL[suggestion.source]} ·{" "}
          {formatDate({
            date: suggestion.createdAt,
            dateFormat: "MMM d, HH:mm",
          })}
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
        <Section title="Rationale">
          <p className="whitespace-pre-wrap">{suggestion.rationale}</p>
        </Section>
        {suggestion.evidence.length > 0 ? (
          <Section title="Evidence">
            <ul className="space-y-1">
              {suggestion.evidence.map((evidence) => (
                <li key={evidenceKey(evidence)}>
                  <EvidenceItem evidence={evidence} />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {policyChange ? <PolicyChangeDetail change={policyChange} /> : null}
        {suggestion.comment ? (
          <Section title="Comment">
            <p className="whitespace-pre-wrap">{suggestion.comment}</p>
          </Section>
        ) : null}
      </div>
      {canUpdate ? (
        <SheetFooter className="flex-row flex-wrap justify-end border-t">
          {suggestion.status === "open" ? (
            <>
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => setCommenting("reject")}
              >
                Reject
              </Button>
              <Button
                variant={policyChange ? "outline" : "default"}
                disabled={action.isPending}
                onClick={() => setCommenting("done")}
              >
                Mark done
              </Button>
              {policyChange ? (
                <PermissionButton
                  permissions={APPLY_PERMISSIONS}
                  disabled={action.isPending}
                  onClick={() => act({ type: "apply", id: suggestion.id })}
                >
                  Apply
                </PermissionButton>
              ) : null}
            </>
          ) : null}
          {suggestion.status === "published" ? (
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => act({ type: "refresh", id: suggestion.id })}
            >
              Refresh
            </Button>
          ) : null}
        </SheetFooter>
      ) : null}
      {commenting ? (
        <CommentDialog
          action={commenting}
          pending={action.isPending}
          onClose={() => setCommenting(null)}
          onSubmit={(comment) =>
            act(
              commenting === "reject"
                ? { type: "reject", id: suggestion.id, comment }
                : { type: "done", id: suggestion.id, comment: comment || null },
            )
          }
        />
      ) : null}
    </>
  );
}

function PolicyChangeDetail({ change }: { change: PolicyChange }) {
  const { gate, publication } = change;
  const failing = gate.files.filter((file) => file.status !== "passed");
  return (
    <>
      <Section title="Verification">
        <div className="space-y-2">
          <Badge
            variant={gate.verification === "verified" ? "secondary" : "outline"}
          >
            {gate.verification === "verified" ? "Verified" : "Unverified"}
          </Badge>
          {gate.reasons.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {gate.reasons.map((reason) => (
                <li key={reason}>{VERIFICATION_REASON_LABEL[reason]}</li>
              ))}
            </ul>
          ) : null}
          {failing.length > 0 ? (
            <ul className="space-y-0.5">
              {failing.map((file) => (
                <li key={file.path} className="break-words">
                  <span className="font-mono text-xs">{file.path}</span>
                  {file.error ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — {file.error}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Section>
      {publication ? (
        <Section title="Publication">
          <a
            href={publication.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
          >
            <span>Pull request #{publication.number}</span>
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </Section>
      ) : null}
      <Section title="Policy edits">
        <div className="space-y-3">
          {change.edits.map((edit, index) => (
            <div
              // Edits have no identity of their own and never reorder.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className="overflow-hidden rounded-md border"
            >
              {edit.replaceAll ? (
                <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
                  Replaces every match
                </p>
              ) : null}
              <HunkEditor
                language="ini"
                original={edit.oldText}
                value={edit.newText}
              />
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}

function EvidenceItem({ evidence }: { evidence: Evidence }) {
  switch (evidence.type) {
    case "k8s_pod":
      return (
        <span>
          Pod <Mono>{`${evidence.namespace}/${evidence.name}`}</Mono>
        </span>
      );
    case "k8s_workload":
      return (
        <span>
          {evidence.kind}{" "}
          <Mono>{`${evidence.namespace}/${evidence.name}`}</Mono>
        </span>
      );
    case "openappa_operation":
      return (
        <span>
          Guardrails operation <Mono>{evidence.operationId}</Mono> in session{" "}
          <Mono>{evidence.sessionId}</Mono>
        </span>
      );
    case "openappa_consult":
      return (
        <Link
          href={`/consults/logs/${evidence.id}`}
          className="underline-offset-4 hover:underline"
        >
          External consult
        </Link>
      );
    case "openappa_yell":
      return (
        <Link
          href={`/openappa/yells/${evidence.id}`}
          className="underline-offset-4 hover:underline"
        >
          Yell
        </Link>
      );
  }
}

function evidenceKey(evidence: Evidence): string {
  switch (evidence.type) {
    case "k8s_pod":
      return `pod:${evidence.namespace}/${evidence.name}`;
    case "k8s_workload":
      return `${evidence.kind}:${evidence.namespace}/${evidence.name}`;
    case "openappa_operation":
      return `operation:${evidence.sessionId}/${evidence.operationId}`;
    case "openappa_consult":
    case "openappa_yell":
      return `${evidence.type}:${evidence.id}`;
  }
}

function CommentDialog({
  action,
  pending,
  onClose,
  onSubmit,
}: {
  action: CommentAction;
  pending: boolean;
  onClose: () => void;
  onSubmit: (comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const required = action === "reject";
  const trimmed = comment.trim();
  return (
    <StandardFormDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={required ? "Reject suggestion" : "Mark suggestion done"}
      description={
        required
          ? "Say why, so the tuner and your team know."
          : "Optionally note what was done."
      }
      size="small"
      onSubmit={(event) => {
        event.preventDefault();
        if (!required || trimmed) onSubmit(trimmed);
      }}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || (required && !trimmed)}>
            {required ? "Reject" : "Mark done"}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="tuner-suggestion-comment">
          {required ? "Reason" : "Comment"}
        </Label>
        <Textarea
          id="tuner-suggestion-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={4}
          aria-required={required}
        />
      </div>
    </StandardFormDialog>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Mono({ children }: { children: string }) {
  return <span className="font-mono text-xs">{children}</span>;
}

const APPLY_PERMISSIONS: Permissions = {
  tuner: ["update"],
  log: ["admin"],
  guardrailsPolicy: ["update"],
};
