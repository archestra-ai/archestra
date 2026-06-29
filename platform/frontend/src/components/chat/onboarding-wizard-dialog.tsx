"use client";

import { ChevronLeft, ChevronRight, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    if (match) {
      const code = String(children).replace(/\n$/, "");
      return (
        <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 border p-3 text-xs">
          <code className={className} {...props}>
            {code}
          </code>
        </pre>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

export interface OnboardingWizardDialogPage {
  image?: string | null;
  content: string;
}

export interface OnboardingWizardDialogWizard {
  label: string;
  pages: OnboardingWizardDialogPage[];
}

interface RuntimeProps {
  mode: "runtime";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wizard: OnboardingWizardDialogWizard;
}

interface EditProps {
  mode: "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  page: OnboardingWizardDialogPage;
  /** Return true to close the dialog; false keeps it open (e.g. save failed) */
  onSave: (page: OnboardingWizardDialogPage) => boolean | Promise<boolean>;
  pageNumber: number;
  pageCount: number;
}

type OnboardingWizardDialogProps = RuntimeProps | EditProps;

export function OnboardingWizardDialog(props: OnboardingWizardDialogProps) {
  if (props.mode === "runtime") {
    return <RuntimeDialog {...props} />;
  }
  return <EditPageDialog {...props} />;
}

function RuntimeDialog({
  open,
  onOpenChange,
  wizard,
}: Omit<RuntimeProps, "mode">) {
  const [step, setStep] = useState(0);
  const pageCount = wizard.pages.length;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (pageCount === 0) return null;

  const safeStep = Math.min(step, pageCount - 1);
  const page = wizard.pages[safeStep];
  const isFirst = safeStep === 0;
  const isLast = safeStep === pageCount - 1;

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={wizard.label?.trim() || "Onboarding"}
      size="large"
      footer={
        <div className="flex flex-1 items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Step {safeStep + 1} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={isFirst}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
            {isLast ? (
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => setStep((s) => Math.min(pageCount - 1, s + 1))}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            )}
          </div>
        </div>
      }
    >
      <TwoColumnPage page={page} />
    </StandardDialog>
  );
}

function EditPageDialog({
  open,
  onOpenChange,
  title,
  page,
  onSave,
  pageNumber,
  pageCount,
}: Omit<EditProps, "mode">) {
  const [draft, setDraft] = useState<OnboardingWizardDialogPage>(page);
  const [tab, setTab] = useState<"markdown" | "preview">("markdown");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(page);
      setTab("markdown");
    }
  }, [open, page]);

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      if (file.type !== "image/png" && file.type !== "image/gif") {
        toast.error("Please upload a PNG or GIF file");
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        toast.error("File size must be less than 2MB");
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target?.result;
        if (typeof base64 === "string") {
          setDraft((prev) => ({ ...prev, image: base64 }));
        }
      };
      reader.readAsDataURL(file);
    },
    [],
  );

  const handleRemoveImage = useCallback(() => {
    setDraft((prev) => ({ ...prev, image: null }));
  }, []);

  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const shouldClose = await onSave(draft);
      if (shouldClose) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, onOpenChange]);

  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="large"
      footer={
        <div className="flex flex-1 items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {pageNumber} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save page"}
            </Button>
          </div>
        </div>
      }
    >
      <div
        className={cn(
          "grid gap-4 min-h-0 h-full",
          draft.image ? "md:grid-cols-2" : "md:grid-cols-1",
        )}
      >
        <div className="flex flex-col min-h-0 rounded-lg border">
          <div className="flex items-center justify-between gap-2 border-b p-1">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant={tab === "markdown" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("markdown")}
              >
                Markdown
              </Button>
              <Button
                type="button"
                variant={tab === "preview" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setTab("preview")}
              >
                Preview
              </Button>
            </div>
            {!draft.image && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-4 w-4 mr-1" />
                Upload image
              </Button>
            )}
          </div>
          {tab === "markdown" ? (
            <Textarea
              value={draft.content}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, content: e.target.value }))
              }
              placeholder="Write page content as markdown. Headings, lists, links, and code blocks are supported."
              className="flex-1 border-0 rounded-none font-mono text-xs resize-none focus-visible:ring-0"
            />
          ) : (
            <div
              className={cn(
                "flex-1 overflow-y-auto p-6",
                MARKDOWN_STYLE_CLASSES,
              )}
            >
              {draft.content.trim().length > 0 ? (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {draft.content}
                </ReactMarkdown>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No content yet. Switch to Markdown to start writing.
                </p>
              )}
            </div>
          )}
        </div>

        {draft.image && (
          <div className="flex flex-col min-h-0 gap-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Image</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-1" />
                  Change
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveImage}
                >
                  <X className="h-4 w-4 mr-1" />
                  Remove
                </Button>
              </div>
            </div>
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={draft.image}
                alt=""
                className="max-w-full max-h-full object-contain"
              />
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/gif"
          className="hidden"
          onChange={handleFileSelect}
        />
      </div>
    </StandardDialog>
  );
}

function TwoColumnPage({ page }: { page: OnboardingWizardDialogPage }) {
  const hasImage = !!page.image;
  return (
    <div
      className={cn(
        "grid gap-6 min-h-0 h-full",
        hasImage ? "md:grid-cols-2" : "md:grid-cols-1",
      )}
    >
      <div
        className={cn(
          "rounded-lg border p-6 overflow-y-auto",
          MARKDOWN_STYLE_CLASSES,
        )}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={markdownComponents}
        >
          {page.content}
        </ReactMarkdown>
      </div>
      {hasImage && (
        <div className="flex items-center justify-center min-h-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={page.image ?? undefined}
            alt=""
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}
    </div>
  );
}

const MARKDOWN_STYLE_CLASSES =
  "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ul]:list-disc [&_ul]:ml-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:my-2 [&_li]:my-1 [&_li>p]:inline [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2 [&_p]:my-2 [&_strong]:font-semibold [&_em]:italic [&_a]:text-primary [&_a]:underline [&_code]:bg-muted [&_code]:text-foreground [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded [&_pre]:my-2 [&_pre]:overflow-x-auto [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:my-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_hr]:my-4 [&_hr]:border-border [&_table]:border-collapse [&_table]:w-full [&_table]:my-4 [&_table]:border [&_table]:border-border [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold [&_thead]:bg-muted";
