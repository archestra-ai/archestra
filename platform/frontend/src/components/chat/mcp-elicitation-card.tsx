"use client";

import { ASK_USER_OTHER_ANSWER_FIELD } from "@archestra/shared";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  Loader2,
} from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  isOtherTextField,
  isSingleChoiceForm,
  normalizeValues,
} from "./mcp-elicitation-fields";
import {
  getReviewDecisionContent,
  getReviewDecisionField,
  type ReviewDecision,
} from "./openappa-review-presentation";
import { OpenappaReviewToolCard } from "./openappa-review-tool-card";

/**
 * Displays pending multiple-choice questions in one inline card with one tab per question.
 * A lone single-choice question is answered by the click itself, with Skip
 * to dismiss; a typed answer comes from the chat composer instead.
 * With several questions, picking an option only selects it: Next moves on.
 * Navigation buttons appear in the footer of each tab.
 * The Submit button on the final tab sends all answers when every question is answered.
 * New questions append as tabs without resetting selections.
 * If a displayed question leaves, the card switches to an adjacent tab.
 */
export function McpElicitationCard({
  requests,
  onRespond,
  groupId,
  members,
  terminalIncomplete = false,
  onTypeAnswer,
}: {
  /** Choice requests only (see `isChoiceElicitationRequest`), oldest first. */
  requests: ChatMcpElicitationRequest[];
  onRespond: (response: ElicitationResponse) => Promise<boolean>;
  groupId?: string;
  members?: AskUserGroupMember[];
  /** The stream ended after this mounted group had live requests but no result. */
  terminalIncomplete?: boolean;
  /** Moves focus to the chat composer, which takes a lone question's typed answer. */
  onTypeAnswer?: () => void;
}) {
  const [valuesById, setValuesById] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [knownRequestsById, setKnownRequestsById] = useState<
    Record<string, ChatMcpElicitationRequest>
  >(() => Object.fromEntries(requests.map((request) => [request.id, request])));
  const [activeId, setActiveId] = useState<string | null>(null);
  // Questions whose "Type something" answer is open; its text box shows only then.
  const [otherOpenById, setOtherOpenById] = useState<Record<string, boolean>>(
    {},
  );
  // Request whose just-opened "Type something" box takes focus after it renders.
  const focusOtherRef = useRef<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAwaitingResults, setIsAwaitingResults] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const hadPendingRequestsRef = useRef(requests.length > 0);
  const stoppedRef = useRef(false);
  const submissionSnapshotRef = useRef<ChatMcpElicitationRequest[] | null>(
    null,
  );
  // Move focus to the active question so keyboard users stay focused after tab changes.
  const focusPanelOnChangeRef = useRef(false);
  // A pointer-opened "Type something" box takes focus; a keyboard user's
  // focus stays where it is.
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
  // A lone OpenAPPA review renders as a tool approval card: its own
  // Approve/Deny row replaces the card header, fields, and footer.
  const isSingleReview =
    !allMembersSettled &&
    !isMultiple &&
    activeQuestion?.request.kind === "openappa_review";
  // A lone single pick answers on click; its typed answer comes from the chat
  // composer. A pick kept after its answer failed to save is retried by
  // pressing it again.
  const answersOnClick = (question: CardQuestion) =>
    !isMultiple && question.isPending && isSingleChoiceForm(question.fields);
  const answersOnClickOnly =
    activeQuestion !== undefined &&
    answersOnClick(activeQuestion) &&
    otherOpenById[activeQuestion.request.id] !== true;

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

  useEffect(() => {
    const requestId = focusOtherRef.current;
    if (!requestId || !otherOpenById[requestId]) {
      return;
    }
    focusOtherRef.current = null;
    formRef.current
      ?.querySelector<HTMLElement>(
        `#${CSS.escape(`mcp-elicitation-${requestId}-${ASK_USER_OTHER_ANSWER_FIELD}`)}`,
      )
      ?.focus();
  }, [otherOpenById]);

  if (!activeQuestion && !allMembersSettled) {
    return null;
  }

  const showQuestion = (id: string, options?: { focusPanel?: boolean }) => {
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
    const other = fields.find(isOtherTextField);
    const typed = other?.name === fieldName;
    // A single pick and "Type something" are alternatives: choosing one clears the other.
    const cleared =
      other && isSingleChoiceForm(fields) && (!typed || value !== "")
        ? Object.fromEntries(
            fields
              .filter((field) => field.name !== fieldName)
              .map((field) => [field.name, ""]),
          )
        : {};
    setValuesById((current) => ({
      ...current,
      [request.id]: {
        ...(current[request.id] ?? getDefaultValues(fields)),
        ...cleared,
        [fieldName]: value,
      },
    }));
    if (other && isSingleChoiceForm(fields) && !typed) {
      setOtherOpen({ question, open: false });
    }
  };

  /**
   * Opening "Type something" on a single pick replaces the pick; closing it drops the
   * typed text, so only what is on screen is sent.
   */
  const setOtherOpen = ({
    question,
    open,
  }: {
    question: CardQuestion;
    open: boolean;
  }) => {
    const { request, fields } = question;
    const other = fields.find(isOtherTextField);
    if (!other) return;
    const cleared = open
      ? isSingleChoiceForm(fields)
        ? Object.fromEntries(
            fields
              .filter((field) => field.name !== other.name)
              .map((field) => [field.name, ""]),
          )
        : {}
      : { [other.name]: "" };
    setValuesById((current) => ({
      ...current,
      [request.id]: {
        ...(current[request.id] ?? getDefaultValues(fields)),
        ...cleared,
      },
    }));
    if (open && lastInputRef.current === "pointer") {
      focusOtherRef.current = request.id;
    }
    setOtherOpenById((current) => ({ ...current, [request.id]: open }));
  };

  const respondToAll = async (
    buildResponse: (question: CardQuestion) => ElicitationResponse,
  ) => {
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

  /**
   * A lone single pick shows its options as buttons, and pressing one
   * answers at once, by pointer or keyboard. The picked value is sent
   * directly: state set by the same press has not rendered yet.
   */
  const pickOption = ({
    question,
    fieldName,
    value,
  }: {
    question: CardQuestion;
    fieldName: string;
    value: string;
  }) => {
    if (!answersOnClick(question) || isSubmitting) {
      return;
    }
    const values = {
      ...Object.fromEntries(question.fields.map((field) => [field.name, ""])),
      [fieldName]: value,
    };
    void respondToAll(({ request, fields }) => ({
      id: request.id,
      action: "accept",
      content: normalizeValues(fields, values),
    }));
  };

  /**
   * Leaves the questions unanswered. Skip is the user's own choice, so it reads
   * as a dismissal: decline would tell the model the form never reached them.
   */
  const skip = () => {
    if (isSubmitting || pendingQuestions.length === 0) {
      return;
    }
    void respondToAll(({ request }) => ({ id: request.id, action: "cancel" }));
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

  /**
   * Approve/Deny answer the review with the same content its form did. A
   * review that is the only pending question submits at once; among other
   * questions it records the pick, like a radio, and Submit sends all.
   */
  const decideReview = (question: CardQuestion, decision: ReviewDecision) => {
    if (isSubmitting || !question.isPending) {
      return;
    }
    const othersPending = pendingQuestions.some(
      (pending) => pending.request.id !== question.request.id,
    );
    if (othersPending) {
      setFieldValue({
        question,
        fieldName: getReviewDecisionField(question.request.requestedSchema),
        value: decision,
      });
      return;
    }
    void respondToAll(({ request }) => ({
      id: request.id,
      action: "accept",
      content: getReviewDecisionContent({
        requestedSchema: request.requestedSchema,
        decision,
      }),
    }));
  };

  const renderReview = (question: CardQuestion) => {
    const picked =
      question.values[getReviewDecisionField(question.request.requestedSchema)];
    return (
      <OpenappaReviewToolCard
        id={questionMessageId(question.request.id)}
        message={question.request.message}
        reviewedTool={question.request.reviewedTool}
        reviewedArguments={question.request.reviewedArguments}
        disabled={isSubmitting || !question.isPending}
        secondaryText={
          isSubmitting ? (
            <span>Saving answer...</span>
          ) : picked === "approve" || picked === "deny" ? (
            <span>Selected: {picked === "approve" ? "Approve" : "Deny"}</span>
          ) : undefined
        }
        onDecide={(decision) => decideReview(question, decision)}
      />
    );
  };

  // Enter on a picked option confirms it, like Next or Submit.
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    lastInputRef.current = "keyboard";
    const role =
      event.target instanceof HTMLElement
        ? event.target.getAttribute("role")
        : null;
    // In the typed answer, Enter sends like the chat composer; Shift+Enter
    // adds a line, and Enter that confirms an IME composition is left alone.
    const sendsTypedAnswer =
      event.target instanceof HTMLTextAreaElement &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing;
    if (
      event.key !== "Enter" ||
      (role !== "radio" && role !== "checkbox" && !sendsTypedAnswer)
    ) {
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
    const otherField = question.fields.find(isOtherTextField);
    const otherOpen = otherOpenById[question.request.id] === true;
    const choiceFields = question.fields.filter(
      (field) => !isOtherTextField(field),
    );
    const disabled = isSubmitting || !question.isPending;
    const inputs = choiceFields.map((field) => (
      <ElicitationFieldInput
        key={field.name}
        idPrefix={question.request.id}
        field={field}
        choiceStyle
        hideLabel={choiceFields.length === 1}
        labelledBy={singlePick ? questionId : undefined}
        value={question.values[field.name]}
        disabled={disabled}
        onChange={(value) =>
          setFieldValue({ question, fieldName: field.name, value })
        }
        onPick={(value) =>
          pickOption({ question, fieldName: field.name, value })
        }
        submitsOnPick={answersOnClick(question)}
        other={
          !otherField || !singlePick
            ? undefined
            : answersOnClick(question)
              ? // The chat composer takes a lone question's typed answer.
                onTypeAnswer
                ? { selected: false, onSelect: onTypeAnswer }
                : undefined
              : {
                  selected: otherOpen,
                  onSelect: () => setOtherOpen({ question, open: true }),
                }
        }
      />
    ));
    if (otherField && !singlePick) {
      inputs.push(
        <ElicitationFieldInput
          key={`${otherField.name}-toggle`}
          idPrefix={question.request.id}
          field={{
            name: `${otherField.name}-toggle`,
            label: otherField.label,
            required: false,
            schema: { type: "boolean" },
          }}
          choiceStyle
          value={otherOpen}
          disabled={disabled}
          onChange={(open) => setOtherOpen({ question, open: open === true })}
        />,
      );
    }
    if (otherField && otherOpen) {
      inputs.push(
        <ElicitationFieldInput
          key={otherField.name}
          idPrefix={question.request.id}
          field={otherField}
          choiceStyle
          hideLabel
          value={question.values[otherField.name]}
          disabled={disabled}
          onChange={(value) =>
            setFieldValue({ question, fieldName: otherField.name, value })
          }
        />,
      );
    }
    return singlePick ? (
      <div className="flex flex-col gap-4">{inputs}</div>
    ) : (
      <fieldset
        aria-labelledby={questionId}
        className="flex min-w-0 flex-col gap-1.5"
      >
        {inputs}
      </fieldset>
    );
  };

  // Tabs only matter with several questions; a single one needs no header.
  const header = isMultiple ? (
    <div className="flex items-center gap-3 px-4 pt-3">
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        <span className="sr-only">Question </span>
        {activeIndex + 1} of {questions.length}
      </span>
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
    </div>
  ) : null;

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
        "not-prose relative mb-4 w-full overflow-hidden rounded-lg",
        !allMembersSettled &&
          !isSingleReview &&
          "border border-border/60 bg-card shadow-sm",
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
            <div className="px-4 pt-3">
              <AnswerSummary members={settledMembers} label="Saved answers" />
            </div>
          ) : null}
          {questions.map((question) => (
            <TabsContent
              key={question.request.id}
              value={question.request.id}
              className="flex min-w-0 flex-col gap-4 p-4"
            >
              {question.request.kind === "openappa_review" ? (
                renderReview(question)
              ) : (
                <>
                  <ElicitationMessage request={question.request} />
                  {renderFields(question)}
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>
      ) : isSingleReview ? (
        renderReview(activeQuestion)
      ) : (
        <>
          {header}
          {settledMembers.length > 0 && !shouldHoldSubmissionSnapshot ? (
            <div className="px-4 pt-3">
              <AnswerSummary members={settledMembers} label="Saved answers" />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col gap-3 px-4 pb-3 pt-4 [&>p:first-child]:font-medium">
            <ElicitationMessage request={activeQuestion.request} />
            {renderFields(activeQuestion)}
          </div>
        </>
      )}
      {!allMembersSettled && !isSingleReview ? (
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
          ) : answersOnClickOnly ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="mcp-elicitation-skip"
              onClick={skip}
            >
              Skip
            </Button>
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
  return (
    <p
      id={questionMessageId(request.id)}
      className="whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
    >
      {request.message}
    </p>
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

/**
 * Settled questions read as the exchange they were: the agent's question on
 * the left, in line with the thinking rows, and the answer on the right as a
 * small reply bubble. Questions without an answer show their outcome there.
 */
function AnswerSummary({
  members,
  label = "Answers",
}: {
  members: AskUserGroupMember[];
  label?: string;
}) {
  return (
    <ul aria-label={label} className="flex min-w-0 flex-col gap-4">
      {members.map((member) => (
        <li key={member.toolCallId} className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 max-w-[80%] items-start gap-2 pl-2">
            <CircleHelpIcon
              className="mt-1 size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div className="flex min-w-0 flex-col gap-2">
              <AnsweredQuestionText question={member.question || "Question"} />
              <OfferedOptions member={member} />
            </div>
          </div>
          {member.outcome?.status === "answered" ? (
            <div className="flex max-w-[80%] flex-col items-end gap-1 self-end">
              <span className="whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary/10 px-3 py-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                {getOutcomeSummary(member)}
              </span>
              {member.outcome.text !== undefined &&
              member.outcome.selected.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                  Typed answer
                </span>
              ) : null}
            </div>
          ) : (
            <span className="self-end text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {getOutcomeSummary(member)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The choices the agent offered, folded behind a link: the reply bubble
 * already shows the pick, so the full list is context on demand. Picked ones
 * carry a check; the rest stay muted.
 */
function OfferedOptions({ member }: { member: AskUserGroupMember }) {
  const [expanded, setExpanded] = useState(false);
  if (member.options.length === 0) return null;
  const selected =
    member.outcome?.status === "answered" ? member.outcome.selected : [];
  const count = member.options.length;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto px-0 text-muted-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>
          {expanded
            ? "Hide options"
            : `Show ${count} ${count === 1 ? "option" : "options"}`}
        </span>
      </Button>
      {expanded ? (
        <OfferedOptionList member={member} selected={selected} />
      ) : null}
    </div>
  );
}

function OfferedOptionList({
  member,
  selected,
}: {
  member: AskUserGroupMember;
  selected: string[];
}) {
  return (
    <ul aria-label="Offered options" className="flex flex-wrap gap-1.5">
      {member.options.map((option) => {
        const picked = selected.includes(option);
        return (
          <li
            key={option}
            aria-current={picked ? "true" : undefined}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs [overflow-wrap:anywhere]",
              picked
                ? "border-primary/30 bg-primary/10 font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {picked ? <CheckIcon className="size-3" aria-hidden /> : null}
            {option}
          </li>
        );
      })}
    </ul>
  );
}

/** A long question folds to three lines so the answer stays in view. */
function AnsweredQuestionText({ question }: { question: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = question.length > LONG_QUESTION_CHARACTERS;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <p
        className={cn(
          // Same reading type as assistant prose (MessageContent): the
          // question is the agent talking, so it should not read as UI chrome.
          "whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-foreground [overflow-wrap:anywhere]",
          isLong && !expanded && "line-clamp-3",
        )}
      >
        {question}
      </p>
      {isLong ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-0 text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? "Show less" : "Show full question"}</span>
        </Button>
      ) : null}
    </div>
  );
}

// Roughly three lines at the chat column's width.
const LONG_QUESTION_CHARACTERS = 240;

function getOutcomeSummary(member: AskUserGroupMember) {
  if (member.outcome?.status === "answered") {
    const { selected, text } = member.outcome;
    return (text === undefined ? selected : [...selected, text]).join(", ");
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
