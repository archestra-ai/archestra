"use client";

import { Pencil, Plus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { OnboardingWizardDialog } from "@/components/chat/onboarding-wizard-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  OnboardingWizardPageValue,
  OnboardingWizardValidationError,
  OnboardingWizardValue,
} from "./onboarding-wizards-editor.utils";
import { sanitizeOnboardingWizard } from "./onboarding-wizards-editor.utils";

const MAX_PAGES = 10;

interface OnboardingWizardEditorProps {
  wizard: OnboardingWizardValue | null;
  validationError: OnboardingWizardValidationError;
  onChange: (wizard: OnboardingWizardValue | null) => void;
  /**
   * Persist the wizard immediately (used by the page-edit dialog so clicking
   * "Save page" doesn't require a second click on the outer settings save bar).
   * Returns whether the persist succeeded so the dialog can close only on success.
   */
  onPersist?: (wizard: OnboardingWizardValue | null) => Promise<boolean>;
}

export function OnboardingWizardEditor({
  wizard,
  validationError,
  onChange,
  onPersist,
}: OnboardingWizardEditorProps) {
  const nextIdRef = useRef(0);
  const createId = useCallback(() => `page-${++nextIdRef.current}`, []);
  const pageIdsRef = useRef<string[]>([]);

  const pages = wizard?.pages ?? [];
  while (pageIdsRef.current.length < pages.length) {
    pageIdsRef.current.push(createId());
  }
  pageIdsRef.current.length = pages.length;

  const [editingPageIndex, setEditingPageIndex] = useState<number | null>(null);

  const handleAddWizard = useCallback(() => {
    pageIdsRef.current = [createId()];
    onChange({ label: "", pages: [{ content: "" }] });
  }, [createId, onChange]);

  const handleRemoveWizard = useCallback(() => {
    pageIdsRef.current = [];
    onChange(null);
  }, [onChange]);

  const handleLabelChange = useCallback(
    (label: string) => {
      if (!wizard) return;
      onChange({ ...wizard, label });
    },
    [onChange, wizard],
  );

  const handleAddPage = useCallback(() => {
    if (!wizard) return;
    if (wizard.pages.length >= MAX_PAGES) return;
    pageIdsRef.current.push(createId());
    onChange({
      ...wizard,
      pages: [...wizard.pages, { content: "" }],
    });
  }, [createId, onChange, wizard]);

  const handleRemovePage = useCallback(
    (index: number) => {
      if (!wizard) return;
      pageIdsRef.current.splice(index, 1);
      const nextPages = wizard.pages.filter((_, i) => i !== index);
      onChange({
        ...wizard,
        pages: nextPages.length > 0 ? nextPages : [{ content: "" }],
      });
    },
    [onChange, wizard],
  );

  const handlePageSave = useCallback(
    async (
      index: number,
      page: OnboardingWizardPageValue,
    ): Promise<boolean> => {
      if (!wizard) return false;
      const nextPages = [...wizard.pages];
      nextPages[index] = page;
      const nextWizard = { ...wizard, pages: nextPages };
      onChange(nextWizard);
      if (onPersist) {
        const sanitized = sanitizeOnboardingWizard(nextWizard);
        return await onPersist(sanitized);
      }
      return true;
    },
    [onChange, onPersist, wizard],
  );

  if (!wizard) {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>Onboarding</Label>
          <p className="text-xs text-muted-foreground">
            Optional step-by-step onboarding dialog shown next to the chat links
            on the new chat page. Pages can include optional images and markdown
            content.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddWizard}
        >
          <Plus className="h-4 w-4" />
          Add onboarding wizard
        </Button>
      </div>
    );
  }

  const pageSummary = (page: OnboardingWizardPageValue) => {
    const trimmed = page.content.trim();
    if (trimmed.length > 0) {
      const firstLine = trimmed.split("\n")[0].replace(/^#+\s*/, "");
      return firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
    }
    if (page.image) return "Image only";
    return "Empty page";
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Onboarding</Label>
        <p className="text-xs text-muted-foreground">
          Optional step-by-step onboarding dialog shown next to the chat links
          on the new chat page.
        </p>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 space-y-2">
            <Label htmlFor="onboardingWizardLabel">Label</Label>
            <Input
              id="onboardingWizardLabel"
              value={wizard.label}
              onChange={(e) => handleLabelChange(e.target.value)}
              placeholder="Setup Microsoft Teams"
              maxLength={25}
              className="max-w-md"
              aria-invalid={!!validationError.label}
            />
            <p
              className={
                validationError.label
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {validationError.label ?? "Required. Max 25 characters."}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemoveWizard}
            className="shrink-0"
            aria-label="Remove onboarding wizard"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-2">
          <Label>Pages</Label>
          <div className="space-y-1">
            {pages.map((page, index) => (
              <div
                key={pageIdsRef.current[index]}
                className="flex items-center gap-2 rounded-md border px-3 py-2"
              >
                <span className="text-xs text-muted-foreground w-12 shrink-0">
                  Page {index + 1}
                </span>
                <span className="flex-1 text-sm truncate">
                  {pageSummary(page)}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingPageIndex(index)}
                >
                  <Pencil className="h-3.5 w-3.5 mr-1" />
                  Edit
                </Button>
                {pages.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleRemovePage(index)}
                    aria-label={`Remove page ${index + 1}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {pages.length < MAX_PAGES && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddPage}
            >
              <Plus className="h-4 w-4" />
              Add page
            </Button>
          )}
          <p
            className={
              validationError.pages
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {validationError.pages ??
              `Up to ${MAX_PAGES} pages. Each page needs content to be saved.`}
          </p>
        </div>
      </div>

      {editingPageIndex !== null && pages[editingPageIndex] && (
        <OnboardingWizardDialog
          mode="edit"
          open={editingPageIndex !== null}
          onOpenChange={(open) => {
            if (!open) setEditingPageIndex(null);
          }}
          title={
            wizard.label.trim().length > 0
              ? `${wizard.label.trim()} — Page ${editingPageIndex + 1}`
              : `Page ${editingPageIndex + 1}`
          }
          page={pages[editingPageIndex]}
          pageNumber={editingPageIndex + 1}
          pageCount={pages.length}
          onSave={async (page) => {
            const ok = await handlePageSave(editingPageIndex, page);
            return ok;
          }}
        />
      )}
    </div>
  );
}
