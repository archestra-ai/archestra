"use client";

import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils/tailwind";
import type { AskUserGroupMember } from "./ask-user-outcome";
import {
  type ChatMcpElicitationRequest,
  type ElicitationField,
  ElicitationFieldInput,
  type ElicitationResponse,
  getDefaultValues,
  getElicitationFields,
  hasChoiceSelection,
  isSingleChoiceForm,
  normalizeValues,
} from "./mcp-elicitation-fields";
import { parseReviewPresentation } from "./openappa-review-presentation";

/**
 * Long enough for the picked row to visibly highlight before the next
 * question replaces it, short enough not to read as lag.
 */
const AUTO_ADVANCE_DELAY_MS = 300;

/**
 * Displays pending multiple-choice questions in one inline card with one tab per question.
 * Selecting an option on a single-choice tab answers it and advances to the next tab.
 * Multiple-choice tabs advance when the user clicks Next.
 * Navigation buttons appear in the footer of each tab.
 * The Submit button on the final tab sends all answers when every question is answered.
 * The close button in the header dismisses the questions.
 * New questions append as tabs without resetting selections.
 * If a displayed question leaves, the card switches to an adjacent tab.
 */
export function McpElicitationCard({
  requests,
  onRespond,
  groupId,
  members,
  terminalIncomplete = false,
}: {
  /** Choice requests only (see `isChoiceElicitationRequest`), oldest first. */
  requests: ChatMcpElicitationRequest[];
  onRespond: (response: ElicitationResponse) => Promise<boolean>;
  groupId?: string;
  members?: AskUserGroupMember[];
  /** The stream ended after this mounted group had live requests but no result. */
  terminalIncomplete?: boolean;
}) {
  const [valuesById, setValuesById] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [knownRequestsById, setKnownRequestsById] = useState<
    Record<string, ChatMcpElicitationRequest>
  >(() => Object.fromEntries(requests.map((request) => [request.id, request])));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAwaitingResults, setIsAwaitingResults] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const hadPendingRequestsRef = useRef(requests.length > 0);
  const stoppedRef = useRef(false);
  const submissionSnapshotRef = useRef<ChatMcpElicitationRequest[] | null>(
    null,
  );
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read by delayed auto-advance to inspect current tabs when the timer fires.
  const questionIdsRef = useRef<string[]>([]);
  // Move focus to the active question so keyboard users stay focused after tab changes.
  const focusPanelOnChangeRef = useRef(false);
  // Clicking an option answers a single-choice tab and advances. Moving
  // between options with arrow keys selects the option without advancing.
  const lastInputRef = useRef<"pointer" | "keyboard">("pointer");
  // Tracks if focus was inside the card, even if a focused control unmounts.
  const focusWithinRef = useRef(false);
  // Tracks whether the user has explicitly selected or navigated between tabs.
  const userSelectedTabRef = useRef(false);
  // Index of the tab displayed in the previous render.
  const shownIndexRef = useRef(0);

  useEffect(() => {
    if (!groupId) {
      return;
    }
    setKnownRequestsById((current) => {
      const next = { ...current };
      for (const request of requests) {
        next[request.id] = request;
      }
      return next;
    });
  }, [groupId, requests]);

  const pendingRequestIds = new Set(requests.map((request) => request.id));
  if (requests.length > 0) {
    hadPendingRequestsRef.current = true;
    stoppedRef.current = false;
  }
  const settledToolCallIds = new Set(
    members
      ?.filter(
        (member) =>
          member.outcome !== null && member.outcome.status !== "waiting",
      )
      .map((member) => member.toolCallId),
  );
  const settledMembers =
    members?.filter(
      (member) =>
        member.outcome !== null && member.outcome.status !== "waiting",
    ) ?? [];
  const hasAllMemberOutcomes =
    members !== undefined &&
    members.length > 0 &&
    members.every(
      (member) =>
        member.outcome !== null && member.outcome.status !== "waiting",
    );
  if (
    terminalIncomplete &&
    requests.length === 0 &&
    hadPendingRequestsRef.current &&
    members !== undefined &&
    members.some(
      (member) =>
        member.outcome === null || member.outcome.status === "waiting",
    )
  ) {
    // A later assistant turn must not reopen this stopped group's controls.
    stoppedRef.current = true;
  }
  const hasTerminalIncompleteMember =
    stoppedRef.current && requests.length === 0 && !hasAllMemberOutcomes;
  // Do not replace the submitted tabs with result rows as each request leaves
  // session state. The snapshot remains until the result stream catches up.
  const allMembersSettled =
    (hasAllMemberOutcomes || hasTerminalIncompleteMember) && !isSubmitting;
  const summaryMembers = hasTerminalIncompleteMember
    ? (members ?? []).map((member) =>
        member.outcome === null || member.outcome.status === "waiting"
          ? { ...member, outcome: { status: "stopped" as const } }
          : member,
      )
    : (members ?? []);
  const memberOrder = useMemo(() => {
    if (!members || members.length === 0) {
      return null;
    }
    return new Map(members.map((member, index) => [member.toolCallId, index]));
  }, [members]);

  const shouldHoldSubmissionSnapshot =
    !!groupId && (isSubmitting || (isAwaitingResults && !allMembersSettled));
  const rawKnownRequests = shouldHoldSubmissionSnapshot
    ? (submissionSnapshotRef.current ?? Object.values(knownRequestsById))
    : groupId
      ? Object.values(knownRequestsById).filter(
          (request) => !settledToolCallIds.has(request.toolCallId ?? ""),
        )
      : requests;
  const knownRequests = useMemo(() => {
    if (!memberOrder) {
      return rawKnownRequests;
    }
    return [...rawKnownRequests].sort((a, b) => {
      const aIndex = a.toolCallId ? memberOrder.get(a.toolCallId) : undefined;
      const bIndex = b.toolCallId ? memberOrder.get(b.toolCallId) : undefined;
      if (aIndex !== undefined && bIndex !== undefined) {
        return aIndex - bIndex;
      }
      if (aIndex !== undefined) {
        return -1;
      }
      if (bIndex !== undefined) {
        return 1;
      }
      return 0;
    });
  }, [rawKnownRequests, memberOrder]);
  const questions = knownRequests.map((request, index): CardQuestion => {
    const fields = getElicitationFields(request.requestedSchema);
    const values = valuesById[request.id] ?? getDefaultValues(fields);
    return {
      request,
      fields,
      values,
      label: request.header?.trim() || `Question ${index + 1}`,
      isAnswered: isQuestionAnswered(fields, values),
      isPending: pendingRequestIds.has(request.id),
    };
  });
  questionIdsRef.current = questions.map((question) => question.request.id);

  const hasUserAnswers = Object.keys(valuesById).length > 0;
  const userHasNavigated = userSelectedTabRef.current || hasUserAnswers;
  const foundIndex = questions.findIndex(
    (question) => question.request.id === activeId,
  );
  const activeIndex = !userHasNavigated
    ? 0
    : foundIndex === -1
      ? Math.max(0, Math.min(shownIndexRef.current, questions.length - 1))
      : foundIndex;
  shownIndexRef.current = activeIndex;
  const activeQuestion = questions[activeIndex];
  const isMultiple = questions.length > 1;
  const isLastTab = activeIndex === questions.length - 1;
  const pendingQuestions = questions.filter((question) => question.isPending);
  const allAnswered =
    pendingQuestions.length > 0 &&
    pendingQuestions.every((question) => question.isAnswered);
  const activeRequestId = activeQuestion?.request.id;

  useEffect(
    () => () => {
      if (advanceTimerRef.current) {
        clearTimeout(advanceTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (allMembersSettled) {
      submissionSnapshotRef.current = null;
      setIsAwaitingResults(false);
    }
  }, [allMembersSettled]);

  // Keeps `activeId` naming the question on screen, so a question that leaves
  // while shown (answered elsewhere, timed out, its call ended) is noticed.
  // Declared before the focus effect below, which it hands focus to in the
  // same commit.
  useEffect(() => {
    if (!activeRequestId || activeId === activeRequestId) {
      return;
    }
    // The shown question left, and its focused control with it: keep a
    // keyboard user in the card rather than dropped on the page.
    if (activeId !== null && focusWithinRef.current) {
      focusPanelOnChangeRef.current = true;
    }
    setActiveId(activeRequestId);
  }, [activeId, activeRequestId]);

  useEffect(() => {
    if (!activeRequestId || !focusPanelOnChangeRef.current) {
      return;
    }
    focusPanelOnChangeRef.current = false;
    // The shown tab's panel, or the first option once a single question is
    // left and the card drops its tabs.
    formRef.current
      ?.querySelector<HTMLElement>(
        '[role="tabpanel"][data-state="active"], [role="radio"], [role="checkbox"]',
      )
      ?.focus();
  }, [activeRequestId]);

  if (!activeQuestion && !allMembersSettled) {
    return null;
  }

  const cancelAutoAdvance = () => {
    if (advanceTimerRef.current) {
      clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  };

  const showQuestion = (id: string, options?: { focusPanel?: boolean }) => {
    cancelAutoAdvance();
    focusPanelOnChangeRef.current = options?.focusPanel ?? false;
    userSelectedTabRef.current = true;
    setActiveId(id);
  };

  const showQuestionAt = (index: number) => {
    const question = questions[index];
    if (question) {
      showQuestion(question.request.id, { focusPanel: true });
    }
  };

  const scheduleAutoAdvance = (fromId: string) => {
    cancelAutoAdvance();
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      const ids = questionIdsRef.current;
      const index = ids.indexOf(fromId);
      if (index === -1 || index === ids.length - 1) {
        return;
      }
      focusPanelOnChangeRef.current = true;
      userSelectedTabRef.current = true;
      setActiveId((current) =>
        (current ?? ids[0]) === fromId ? ids[index + 1] : current,
      );
    }, AUTO_ADVANCE_DELAY_MS);
  };

  // A click on an option answers a single-choice tab, even a click on the
  // option already picked (going back to a tab to confirm its answer).
  const advanceOnPick = (question: CardQuestion) => {
    if (
      isMultiple &&
      isSingleChoiceForm(question.fields) &&
      lastInputRef.current === "pointer"
    ) {
      scheduleAutoAdvance(question.request.id);
    }
  };

  const setFieldValue = ({
    question,
    fieldName,
    value,
  }: {
    question: CardQuestion;
    fieldName: string;
    value: unknown;
  }) => {
    const { request, fields } = question;
    setValuesById((current) => ({
      ...current,
      [request.id]: {
        ...(current[request.id] ?? getDefaultValues(fields)),
        [fieldName]: value,
      },
    }));
    advanceOnPick(question);
  };

  const respondToAll = async (
    buildResponse: (question: CardQuestion) => ElicitationResponse,
  ) => {
    cancelAutoAdvance();
    // Freeze only questions the backend is still waiting on. Already-settled
    // or acknowledged members stay out so a later dismiss cannot resurrect them.
    submissionSnapshotRef.current = pendingQuestions.map(
      (question) => question.request,
    );
    setIsSubmitting(true);
    // Only submit requests the backend is still waiting on. The saved members
    // stay in this stable card until their matching tool results arrive.
    const responses = await Promise.allSettled(
      pendingQuestions.map((question) => onRespond(buildResponse(question))),
    );
    setIsSubmitting(false);
    const hasRetryableRequest = responses.some(
      (response) => response.status === "rejected" || response.value === false,
    );
    setIsAwaitingResults(!hasRetryableRequest);
    if (hasRetryableRequest) {
      submissionSnapshotRef.current = null;
    }
  };

  const submit = () => {
    if (!allAnswered || isSubmitting || pendingQuestions.length === 0) {
      return;
    }
    void respondToAll(({ request, fields, values }) => ({
      id: request.id,
      action: "accept",
      content: normalizeValues(fields, values),
    }));
  };

  const dismiss = () => {
    void respondToAll(({ request }) => ({
      id: request.id,
      action: "cancel",
    }));
  };

  // Enter on a picked option confirms it, like the click that auto-advances.
  // Escape on an option or tab dismisses the pending questions.
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    lastInputRef.current = "keyboard";
    const role =
      event.target instanceof HTMLElement
        ? event.target.getAttribute("role")
        : null;
    if (
      event.key === "Escape" &&
      (role === "radio" || role === "checkbox" || role === "tab") &&
      !isSubmitting &&
      pendingQuestions.length > 0
    ) {
      event.preventDefault();
      dismiss();
      return;
    }
    if (event.key !== "Enter" || (role !== "radio" && role !== "checkbox")) {
      return;
    }
    event.preventDefault();
    if (!activeQuestion.isAnswered) {
      return;
    }
    if (isLastTab) {
      submit();
    } else {
      showQuestionAt(activeIndex + 1);
    }
  };

  // The question names its options: a single pick's radio group directly,
  // several checkboxes (or fields) through the group around them.
  const renderFields = (question: CardQuestion) => {
    const questionId = questionMessageId(question.request.id);
    const singlePick = isSingleChoiceForm(question.fields);
    const inputs = question.fields.map((field) => (
      <ElicitationFieldInput
        key={field.name}
        idPrefix={question.request.id}
        field={field}
        choiceStyle
        hideLabel={question.fields.length === 1}
        labelledBy={singlePick ? questionId : undefined}
        value={question.values[field.name]}
        disabled={isSubmitting || !question.isPending}
        onChange={(value) =>
          setFieldValue({ question, fieldName: field.name, value })
        }
        onPick={() => advanceOnPick(question)}
      />
    ));
    return singlePick ? (
      <div className="flex flex-col gap-4">{inputs}</div>
    ) : (
      <fieldset
        aria-labelledby={questionId}
        className="flex min-w-0 flex-col gap-4"
      >
        {inputs}
      </fieldset>
    );
  };

  const header = (
    <div
      className={cn(
        "flex items-center gap-3",
        isMultiple ? "px-4 pt-3" : "absolute right-2 top-2 z-10",
      )}
    >
      {isMultiple ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          <span className="sr-only">Question </span>
          {activeIndex + 1} of {questions.length}
        </span>
      ) : null}
      {isMultiple ? (
        <TabsList
          size="sm"
          aria-label="Questions"
          className="h-7 min-w-0 justify-start overflow-x-auto"
        >
          {questions.map((question, index) => (
            <TabsTrigger
              key={question.request.id}
              value={question.request.id}
              data-testid={`mcp-elicitation-tab-${index}`}
              className="max-w-40 flex-none gap-1"
            >
              {question.isAnswered ? (
                <CheckIcon className="size-3 text-emerald-600" aria-hidden />
              ) : null}
              <span className="min-w-0 truncate">{question.label}</span>
              {question.isAnswered ? (
                <span className="sr-only">(answered)</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={isMultiple ? "Dismiss questions" : "Dismiss question"}
        title={isMultiple ? "Dismiss questions" : "Dismiss question"}
        data-testid="mcp-elicitation-dismiss"
        disabled={isSubmitting || pendingQuestions.length === 0}
        onClick={dismiss}
        className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );

  return (
    <form
      ref={formRef}
      data-testid={groupId ? "ask-user-tool-group" : "mcp-elicitation-card"}
      data-group-id={groupId}
      data-state={allMembersSettled ? "settled" : "pending"}
      aria-label={allMembersSettled || isMultiple ? "Questions" : undefined}
      aria-labelledby={
        allMembersSettled || isMultiple || !activeQuestion
          ? undefined
          : questionMessageId(activeQuestion.request.id)
      }
      className={cn(
        "not-prose relative mb-4 w-full overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm",
        isMultiple || activeQuestion?.request.kind === "openappa_review"
          ? "max-w-4xl"
          : "max-w-2xl",
      )}
      onPointerDown={() => {
        lastInputRef.current = "pointer";
      }}
      onFocus={() => {
        focusWithinRef.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          focusWithinRef.current = false;
        }
      }}
      onKeyDown={handleKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {allMembersSettled ? (
        <AnswerSummary members={summaryMembers} />
      ) : isMultiple ? (
        <Tabs
          value={activeQuestion.request.id}
          onValueChange={(id) => showQuestion(id)}
          className="gap-0"
        >
          {header}
          {settledMembers.length > 0 && !shouldHoldSubmissionSnapshot ? (
            <AnswerSummary members={settledMembers} label="Saved answers" />
          ) : null}
          {questions.map((question) => (
            <TabsContent
              key={question.request.id}
              value={question.request.id}
              className="flex min-w-0 flex-col gap-4 p-4"
            >
              <ElicitationMessage request={question.request} />
              {renderFields(question)}
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <>
          {header}
          {settledMembers.length > 0 && !shouldHoldSubmissionSnapshot ? (
            <AnswerSummary members={settledMembers} label="Saved answers" />
          ) : null}
          <div className="flex min-w-0 flex-col gap-3 px-4 pb-3 pt-4 [&>p:first-child]:pr-8 [&>p:first-child]:font-medium">
            <ElicitationMessage request={activeQuestion.request} />
            {renderFields(activeQuestion)}
          </div>
        </>
      )}
      {!allMembersSettled ? (
        <div
          data-testid="mcp-elicitation-footer"
          className={cn(
            "flex items-center justify-end gap-1 px-3 pb-3",
            isMultiple && "border-t border-border/60 py-2",
          )}
        >
          {isMultiple && activeIndex > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid="mcp-elicitation-back"
              disabled={isSubmitting}
              onClick={() => showQuestionAt(activeIndex - 1)}
            >
              <ChevronLeftIcon aria-hidden />
              <span>Back</span>
            </Button>
          ) : null}
          {isSubmitting ? (
            <span className="text-xs text-muted-foreground">
              Saving answers...
            </span>
          ) : shouldHoldSubmissionSnapshot ? (
            <span className="text-xs text-muted-foreground">
              Waiting for answer results...
            </span>
          ) : pendingQuestions.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              Waiting for answers...
            </span>
          ) : isLastTab ? (
            <Button
              key="submit"
              type="submit"
              size="sm"
              data-testid="mcp-elicitation-submit"
              disabled={isSubmitting || !allAnswered}
            >
              {isSubmitting ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <CheckIcon aria-hidden />
              )}
              <span>Submit</span>
            </Button>
          ) : (
            <Button
              key="next"
              type="button"
              variant="secondary"
              size="sm"
              data-testid="mcp-elicitation-next"
              disabled={isSubmitting}
              onClick={() => showQuestionAt(activeIndex + 1)}
            >
              <span>Next</span>
              <ChevronRightIcon aria-hidden />
            </Button>
          )}
        </div>
      ) : null}
    </form>
  );
}

function ElicitationMessage({
  request,
}: {
  request: ChatMcpElicitationRequest;
}) {
  const id = questionMessageId(request.id);
  if (request.kind !== "openappa_review") {
    return (
      <p
        id={id}
        className="whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
      >
        {request.message}
      </p>
    );
  }

  const presentation = parseReviewPresentation({
    message: request.message,
    reviewedTool: request.reviewedTool,
    reviewedArguments: request.reviewedArguments,
  });
  const toolType = `tool-${presentation.tool ?? "call"}` as const;

  return (
    <div id={id} className="flex min-w-0 flex-col gap-3">
      {presentation.intro ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
          {presentation.intro}
        </p>
      ) : null}
      {presentation.tool || presentation.arguments !== undefined ? (
        <Tool defaultOpen className="mb-0">
          <ToolHeader
            type={toolType}
            state="approval-requested"
            title={presentation.tool}
            isCollapsible={false}
            statusLabel="Needs review"
          />
          {presentation.arguments !== undefined ? (
            <ToolContent>
              <ToolInput input={presentation.arguments} />
            </ToolContent>
          ) : null}
        </Tool>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
          {request.message}
        </p>
      )}
      {presentation.rest ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
          {presentation.rest}
        </p>
      ) : null}
    </div>
  );
}

type CardQuestion = {
  request: ChatMcpElicitationRequest;
  fields: ElicitationField[];
  values: Record<string, unknown>;
  /** The request's `header`, or "Question N" when it sent none. */
  label: string;
  isAnswered: boolean;
  isPending: boolean;
};

function AnswerSummary({
  members,
  label = "Answers",
}: {
  members: AskUserGroupMember[];
  label?: string;
}) {
  return (
    <ul aria-label={label} className="flex min-w-0 flex-col gap-3 p-4">
      {members.map((member) => (
        <li key={member.toolCallId} className="flex min-w-0 flex-col gap-1">
          <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {member.question || "Question"}
          </p>
          <span
            className={
              member.outcome?.status === "answered"
                ? "text-sm text-foreground [overflow-wrap:anywhere]"
                : "text-xs text-muted-foreground [overflow-wrap:anywhere]"
            }
          >
            {getOutcomeSummary(member)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function getOutcomeSummary(member: AskUserGroupMember) {
  if (member.outcome?.status === "answered") {
    return member.outcome.selected.join(", ");
  }
  switch (member.outcome?.status) {
    case "declined":
      return "Declined";
    case "dismissed":
      return "Dismissed";
    case "timed-out":
      return "No answer in time";
    case "stopped":
      return "Stopped without an answer";
    default:
      return "Waiting for answer...";
  }
}

/** Id of a question's text, which names its options for assistive tech. */
function questionMessageId(requestId: string) {
  return `mcp-elicitation-${requestId}-question`;
}

function isQuestionAnswered(
  fields: ElicitationField[],
  values: Record<string, unknown>,
) {
  return hasChoiceSelection(fields, values);
}
