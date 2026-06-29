export interface OnboardingWizardPageValue {
  image?: string | null;
  content: string;
}

export interface OnboardingWizardValue {
  label: string;
  pages: OnboardingWizardPageValue[];
}

export interface OnboardingWizardValidationError {
  label?: string;
  pages?: string;
}

interface ValidateOptions {
  requireComplete?: boolean;
}

export function sanitizeOnboardingWizard(
  wizard: OnboardingWizardValue | null,
): OnboardingWizardValue | null {
  if (!wizard) return null;
  const label = wizard.label.trim();
  const pages = wizard.pages
    .map((page) => ({
      image: page.image ?? null,
      content: page.content,
    }))
    .filter(
      (page) => page.content.trim().length > 0 || (page.image ?? "") !== "",
    );
  if (label.length === 0 || pages.length === 0) return null;
  return { label, pages };
}

export function validateOnboardingWizard(
  wizard: OnboardingWizardValue | null,
  options?: ValidateOptions,
): OnboardingWizardValidationError {
  if (!wizard) return {};

  const trimmedLabel = wizard.label.trim();
  const requireComplete = options?.requireComplete ?? false;
  const errors: OnboardingWizardValidationError = {};

  const hasAnyContent =
    trimmedLabel.length > 0 ||
    wizard.pages.some(
      (page) => page.content.trim().length > 0 || (page.image ?? "") !== "",
    );

  if (!hasAnyContent) return {};

  if (trimmedLabel.length === 0) {
    errors.label = "Enter a label.";
  } else if (trimmedLabel.length > 25) {
    errors.label = "Label must be 25 characters or fewer.";
  }

  const nonEmptyPages = wizard.pages.filter(
    (page) => page.content.trim().length > 0,
  );

  if (nonEmptyPages.length === 0) {
    if (requireComplete) {
      errors.pages = "Add at least one page with content.";
    }
  } else if (wizard.pages.length > 10) {
    errors.pages = "A wizard can have at most 10 pages.";
  }

  return errors;
}
