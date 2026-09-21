"use client";

import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  type ChatMcpElicitationRequest,
  type ElicitationField,
  ElicitationFieldInput,
  type ElicitationResponse,
  getDefaultValues,
  getElicitationFields,
  normalizeValues,
  validateValues,
} from "./mcp-elicitation-fields";

/**
 * Modal form for an elicitation that is not a plain multiple-choice question
 * (free text, numbers, a URL to open). Multiple-choice questions render inline
 * in the chat instead, see `McpElicitationCard`.
 */
type ElicitationAction = "accept" | "decline" | "cancel";
type ElicitationResponder = (response: ElicitationResponse) => Promise<boolean>;

export function McpElicitationDialog({
  request,
  isSubmitting,
  onRespond,
}: {
  request: ChatMcpElicitationRequest | null;
  isSubmitting: boolean;
  onRespond: ElicitationResponder;
}) {
  const fields = useMemo(
    () => getElicitationFields(request?.requestedSchema),
    [request?.requestedSchema],
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setValues(getDefaultValues(fields));
    setErrors({});
  }, [fields]);

  if (!request) {
    return null;
  }

  // Only the platform marks a request as an OpenAPPA review.
  // Third-party servers cannot display approval controls.
  if (request.kind === "openappa_review") {
    return (
      <RemedyReviewDialog
        request={request}
        isSubmitting={isSubmitting}
        onRespond={onRespond}
      />
    );
  }

  const submit = async () => {
    const validationErrors = validateValues(fields, values);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) {
      return;
    }

    await onRespond({
      id: request.id,
      action: "accept",
      content: normalizeValues(fields, values),
    });
  };

  const respondWithoutContent = async (action: "decline" | "cancel") => {
    await onRespond({ id: request.id, action });
  };

  return (
    <StandardFormDialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) void respondWithoutContent("cancel");
      }}
      title="Additional Information"
      description={request.message}
      size="small"
      preventCloseOnInteractOutside
      onSubmit={submit}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => void respondWithoutContent("decline")}
          >
            <XIcon />
            Decline
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => void respondWithoutContent("cancel")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            <CheckIcon />
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {request.mode === "url" && isHttpUrl(request.url) ? (
          <a
            href={request.url}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-primary underline underline-offset-4"
          >
            Open request
          </a>
        ) : null}

        {fields.length === 0 ? (
          <Textarea
            value={String(values.response ?? "")}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                response: event.target.value,
              }))
            }
            placeholder="Response"
            aria-label="Response"
            className="min-h-24"
          />
        ) : (
          fields.map((field) => (
            <ElicitationFieldInput
              key={field.name}
              idPrefix={request.id}
              field={field}
              choiceStyle={false}
              value={values[field.name]}
              error={errors[field.name]}
              onChange={(value) =>
                setValues((current) => {
                  setErrors((currentErrors) => {
                    if (!currentErrors[field.name]) {
                      return currentErrors;
                    }

                    const nextErrors = { ...currentErrors };
                    delete nextErrors[field.name];
                    return nextErrors;
                  });

                  return { ...current, [field.name]: value };
                })
              }
            />
          ))
        )}
      </div>
    </StandardFormDialog>
  );
}

/**
 * Review dialog for a tool call held by guardrails policy.
 * Displays the tool name and exact arguments in preformatted text.
 * The action buttons provide the complete response.
 */
function RemedyReviewDialog({
  request,
  isSubmitting,
  onRespond,
}: {
  request: ChatMcpElicitationRequest;
  isSubmitting: boolean;
  onRespond: ElicitationResponder;
}) {
  const respond = (action: ElicitationAction) =>
    onRespond(
      action === "accept"
        ? { id: request.id, action, content: { action: "approve" } }
        : { id: request.id, action },
    );

  return (
    <StandardFormDialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) void respond("cancel");
      }}
      title="Approval Required"
      description="Review this tool call before it can run."
      size="medium"
      preventCloseOnInteractOutside
      onSubmit={() => void respond("accept")}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => void respond("decline")}
          >
            <XIcon />
            Decline
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => void respond("cancel")}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            <CheckIcon />
            Approve
          </Button>
        </>
      }
    >
      <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">
        {request.message}
      </pre>
    </StandardFormDialog>
  );
}

function titleize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isHttpUrl(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
