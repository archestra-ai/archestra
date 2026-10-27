"use client";

import {
  ChevronRight,
  Code2,
  Eye,
  FileText,
  Info,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExpirySelect } from "@/components/credential-billing/expiry-select";
import { Editor } from "@/components/editor";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field-description";
import { InlineNotice } from "@/components/ui/inline-notice";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type {
  OnboardingWizardPageValue,
  OnboardingWizardValidationError,
  OnboardingWizardValue,
} from "./onboarding-wizards-editor.utils";

export function OnboardingGuide({
  wizard,
  errors,
  disabled,
  onChange,
}: {
  wizard: OnboardingWizardValue | null;
  errors: OnboardingWizardValidationError;
  disabled: boolean;
  onChange: (value: OnboardingWizardValue | null) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState<number | null>(null);
  const next = useRef(0);
  const keys = useRef<string[]>([]);
  const pages = wizard?.pages ?? [];
  while (keys.current.length < pages.length)
    keys.current.push(`${id}-${++next.current}`);
  keys.current.length = pages.length;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Label>Onboarding</Label>
          <FieldDescription>
            A step-by-step guide on the new chat page.
          </FieldDescription>
        </div>
        {wizard ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Remove onboarding guide"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <Trash2 />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              onChange({
                label: "Getting started",
                pages: [{ content: "", image: null }],
              })
            }
          >
            <Plus />
            <span>Add guide</span>
          </Button>
        )}
      </div>
      {wizard ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-label`}>Button label</Label>
            <FieldDescription id={`${id}-label-description`}>
              Text on the button that opens this guide.
            </FieldDescription>
            <Input
              id={`${id}-label`}
              aria-describedby={`${id}-label-description`}
              aria-invalid={!!errors.label}
              value={wizard.label}
              maxLength={25}
              disabled={disabled}
              placeholder="Getting started"
              onChange={(event) =>
                onChange({ ...wizard, label: event.target.value })
              }
            />
            {errors.label && <ValidationMessage message={errors.label} />}
          </div>
          <div className="space-y-2">
            <Label>Pages</Label>
            <div className="divide-y border-y">
              {pages.map((page, index) => (
                <div
                  key={keys.current[index]}
                  className="flex min-w-0 items-center gap-2 py-1"
                >
                  <UnstyledButton
                    aria-label={`${disabled ? "View" : "Edit"} onboarding page ${index + 1}`}
                    aria-haspopup="dialog"
                    onClick={() => setEditing(index)}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded py-2 text-left hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="w-5 shrink-0 text-center font-mono text-xs text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {page.image ? (
                      <img
                        src={page.image}
                        alt=""
                        className="size-6 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {pageSummary(page)}
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </UnstyledButton>
                  {pages.length > 1 && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove onboarding page ${index + 1}`}
                      disabled={disabled}
                      onClick={() => {
                        keys.current.splice(index, 1);
                        onChange({
                          ...wizard,
                          pages: pages.filter((_, i) => i !== index),
                        });
                      }}
                    >
                      <X />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {pages.length}/10 pages
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || pages.length >= 10}
                onClick={() => setEditing(pages.length)}
              >
                <Plus />
                <span>Add page</span>
              </Button>
            </div>
            {errors.pages && <ValidationMessage message={errors.pages} />}
          </div>
          {editing !== null && (
            <GuidePageDialog
              page={pages[editing] ?? { content: "", image: null }}
              number={editing + 1}
              disabled={disabled}
              onClose={() => setEditing(null)}
              onKeep={(page) => {
                if (disabled) return;
                onChange({
                  ...wizard,
                  pages:
                    editing < pages.length
                      ? pages.map((item, i) => (i === editing ? page : item))
                      : [...pages, page],
                });
                setEditing(null);
              }}
            />
          )}
        </>
      ) : (
        <FieldDescription>No onboarding guide configured.</FieldDescription>
      )}
    </div>
  );
}

export function SiteAnnouncement({
  content,
  expiresAt,
  disabled,
  onChange,
  onRemove,
}: {
  content: string;
  expiresAt: Date | null;
  disabled: boolean;
  onChange: (content: string, expiresAt: Date | null) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Site notification</Label>
        <FieldDescription>
          An announcement shown across the app.
        </FieldDescription>
      </div>
      {content.trim() ? (
        <div className="flex min-w-0 items-center gap-3 border-y py-2">
          <UnstyledButton
            aria-label={`${disabled ? "View" : "Edit"} site notification`}
            aria-haspopup="dialog"
            onClick={() => setEditing(true)}
            className="flex min-w-0 flex-1 items-center gap-3 rounded py-2 text-left hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-sm">
                {content
                  .replace(/[*#`>]/g, "")
                  .split("\n")
                  .find((line) => line.trim()) || "Site notification"}
              </p>
              <FieldDescription>
                {expiresAt
                  ? `${expiresAt.getTime() < Date.now() ? "Expired" : "Expires"} ${formatExpiration(expiresAt)}`
                  : "No expiration"}
              </FieldDescription>
            </div>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </UnstyledButton>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Remove site notification"
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <FieldDescription>No announcement configured.</FieldDescription>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            <Plus />
            <span>Add notification</span>
          </Button>
        </div>
      )}
      {editing && (
        <AnnouncementDialog
          content={content}
          expiresAt={expiresAt}
          disabled={disabled}
          onClose={() => setEditing(false)}
          onKeep={(nextContent, expiration) => {
            if (disabled) return;
            onChange(nextContent, expiration);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}

function GuidePageDialog({
  page,
  number,
  disabled,
  onClose,
  onKeep,
}: {
  page: OnboardingWizardPageValue;
  number: number;
  disabled: boolean;
  onClose: () => void;
  onKeep: (page: OnboardingWizardPageValue) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState({
    content: page.content,
    image: page.image ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Onboarding page ${number}`}
      description="Content and image for this step."
      size="medium"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            <span>{disabled ? "Done" : "Cancel"}</span>
          </Button>
          {!disabled && (
            <Button
              onClick={() => {
                if (!draft.content.trim() && !draft.image) {
                  setError("Add content or an image.");
                  return;
                }
                onKeep(draft);
              }}
            >
              <span>Keep page</span>
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <MarkdownEditor
          id={`${id}-content`}
          label="Page content"
          description="Write the content for this step using Markdown."
          value={draft.content}
          disabled={disabled}
          onChange={(content) => {
            setDraft({ ...draft, content });
            setError(null);
          }}
        />
        {error && <ValidationMessage message={error} />}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {draft.image && (
              <img
                src={draft.image}
                alt="Page illustration"
                className="size-8 rounded border object-contain"
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              aria-describedby={`${id}-image-description`}
              onClick={() => input.current?.click()}
            >
              <Upload />
              <span>{draft.image ? "Replace image" : "Attach image"}</span>
            </Button>
            <FieldDescription id={`${id}-image-description`}>
              Optional · PNG or GIF · 2 MB max
            </FieldDescription>
            {draft.image && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove image"
                disabled={disabled}
                onClick={() => setDraft({ ...draft, image: null })}
              >
                <X />
              </Button>
            )}
            <Input
              ref={input}
              type="file"
              className="hidden"
              accept="image/png,image/gif"
              aria-label="Onboarding page image"
              aria-describedby={`${id}-image-description`}
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (!["image/png", "image/gif"].includes(file.type)) {
                  setImageError("Upload a PNG or GIF file.");
                  return;
                }
                if (file.size > 2 * 1024 * 1024) {
                  setImageError("File size must be less than 2 MB.");
                  return;
                }
                setImageError(null);
                const reader = new FileReader();
                reader.onload = () => {
                  setDraft((current) => ({
                    ...current,
                    image: String(reader.result),
                  }));
                  setError(null);
                };
                reader.readAsDataURL(file);
              }}
            />
          </div>
          {imageError && <ValidationMessage message={imageError} />}
        </div>
      </div>
    </StandardDialog>
  );
}

function AnnouncementDialog({
  content,
  expiresAt,
  disabled,
  onClose,
  onKeep,
}: {
  content: string;
  expiresAt: Date | null;
  disabled: boolean;
  onClose: () => void;
  onKeep: (content: string, expiresAt: Date | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(content);
  const [expiration, setExpiration] = useState(expiresAt);
  const [error, setError] = useState<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <StandardDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Site notification"
      description="Edit the announcement shown across the app."
      size="medium"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            <span>{disabled ? "Done" : "Cancel"}</span>
          </Button>
          {!disabled && (
            <Button
              onClick={() => {
                if (!draft.trim()) {
                  setError("Enter notification content.");
                  return;
                }
                onKeep(draft, expiration);
              }}
            >
              <span>Keep changes</span>
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <MarkdownEditor
          id={`${id}-content`}
          label="Notification content"
          description="Markdown formatting is supported."
          value={draft}
          disabled={disabled}
          onChange={(value) => {
            setDraft(value);
            setError(null);
          }}
        />
        {error && <ValidationMessage message={error} />}
        <div className="space-y-2">
          <Label htmlFor={`${id}-expiration`}>Expiration</Label>
          <FieldDescription>
            Optional. Times shown in {timeZone}.
          </FieldDescription>
          <fieldset disabled={disabled}>
            <ExpirySelect
              id={`${id}-expiration`}
              value={expiration}
              onChange={setExpiration}
            />
          </fieldset>
        </div>
      </div>
    </StandardDialog>
  );
}

function MarkdownEditor({
  id,
  label,
  description,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  const [height, setHeight] = useState(120);
  const action = preview ? "Back to Markdown editor" : "Preview Markdown";
  return (
    <div className="space-y-2">
      <Label id={`${id}-label`}>{label}</Label>
      <FieldDescription id={`${id}-description`}>
        {description}
      </FieldDescription>
      <fieldset
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        className="min-w-0 overflow-hidden rounded-md border border-input"
      >
        <div className="flex h-8 items-center justify-between border-b bg-muted/30 px-1">
          <span className="px-2 text-xs text-muted-foreground">
            {preview ? "Preview" : "Markdown"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={action}
                aria-pressed={preview}
                aria-controls={`${id}-editor`}
                onClick={() => setPreview(!preview)}
              >
                {preview ? <Code2 /> : <Eye />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{action}</TooltipContent>
          </Tooltip>
        </div>
        <div id={`${id}-editor`} style={{ height }}>
          <div className={preview ? "hidden" : "h-full"}>
            <Editor
              height="100%"
              language="markdown"
              value={value}
              onChange={(content) => {
                if (!disabled) onChange(content ?? "");
              }}
              loading={<Skeleton className="h-full rounded-none" />}
              onMount={(editor) => {
                const syncHeight = () =>
                  setHeight(
                    Math.min(320, Math.max(120, editor.getContentHeight())),
                  );
                syncHeight();
                editor.onDidContentSizeChange(syncHeight);
                if (!disabled) editor.focus();
              }}
              options={{
                ariaLabel: label,
                readOnly: disabled,
                minimap: { enabled: false },
                lineNumbers: "off",
                lineDecorationsWidth: 12,
                lineNumbersMinChars: 0,
                folding: false,
                glyphMargin: false,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                fontSize: 13,
                lineHeight: 20,
                padding: { top: 10, bottom: 10 },
                renderLineHighlight: "none",
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                automaticLayout: true,
                quickSuggestions: false,
                wordBasedSuggestions: "off",
                scrollbar: { alwaysConsumeMouseWheel: false },
                // Monaco's EditContext input does not work in Radix dialogs.
                editContext: false,
              }}
            />
          </div>
          {preview && (
            <section
              aria-label={`${label} preview`}
              className="h-full min-w-0 overflow-y-auto px-3 py-2 text-sm wrap-anywhere [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_a]:text-primary [&_a]:underline"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {value.trim() || "No content to preview."}
              </ReactMarkdown>
            </section>
          )}
        </div>
      </fieldset>
    </div>
  );
}

function ValidationMessage({ message }: { message: string }) {
  return (
    <InlineNotice variant="error">
      <Info />
      <span className="font-medium">{message}</span>
    </InlineNotice>
  );
}

function pageSummary(page: OnboardingWizardPageValue) {
  return (
    page.content
      .trim()
      .split("\n")[0]
      .replace(/^#+\s*/, "") || (page.image ? "Image only" : "Empty page")
  );
}

function formatExpiration(value: Date) {
  return value.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
