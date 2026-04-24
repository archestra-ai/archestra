import { describe, expect, it } from "vitest";
import {
  sanitizeOnboardingWizard,
  validateOnboardingWizard,
} from "./onboarding-wizards-editor.utils";

describe("onboarding-wizards-editor utils", () => {
  describe("sanitizeOnboardingWizard", () => {
    it("trims label and drops pages without content or image", () => {
      expect(
        sanitizeOnboardingWizard({
          label: " Setup ",
          pages: [
            { content: " " },
            { content: "Step 1" },
            { content: " ", image: "data:image/png;base64,AAA" },
          ],
        }),
      ).toEqual({
        label: "Setup",
        pages: [
          { image: null, content: "Step 1" },
          { image: "data:image/png;base64,AAA", content: " " },
        ],
      });
    });

    it("returns null when the wizard has no label", () => {
      expect(
        sanitizeOnboardingWizard({
          label: "   ",
          pages: [{ content: "hi" }],
        }),
      ).toBeNull();
    });

    it("returns null when no page has content or image", () => {
      expect(
        sanitizeOnboardingWizard({
          label: "Setup",
          pages: [{ content: "   " }],
        }),
      ).toBeNull();
    });

    it("passes null through", () => {
      expect(sanitizeOnboardingWizard(null)).toBeNull();
    });
  });

  describe("validateOnboardingWizard", () => {
    it("treats a wizard with no content as valid (will be discarded on save)", () => {
      expect(
        validateOnboardingWizard({
          label: " ",
          pages: [{ content: " " }],
        }),
      ).toEqual({});
    });

    it("requires a label once any content is present", () => {
      expect(
        validateOnboardingWizard({
          label: "",
          pages: [{ content: "hello" }],
        }),
      ).toEqual({ label: "Enter a label." });
    });

    it("rejects labels longer than 25 chars", () => {
      expect(
        validateOnboardingWizard({
          label: "A".repeat(26),
          pages: [{ content: "hello" }],
        }),
      ).toEqual({ label: "Label must be 25 characters or fewer." });
    });

    it("requires at least one non-empty page on save", () => {
      expect(
        validateOnboardingWizard(
          { label: "Setup", pages: [{ content: " " }] },
          { requireComplete: true },
        ),
      ).toEqual({ pages: "Add at least one page with content." });
    });

    it("rejects more than 10 pages", () => {
      expect(
        validateOnboardingWizard({
          label: "Setup",
          pages: Array.from({ length: 11 }, (_, i) => ({
            content: `Page ${i}`,
          })),
        }),
      ).toEqual({ pages: "A wizard can have at most 10 pages." });
    });

    it("passes null through", () => {
      expect(validateOnboardingWizard(null)).toEqual({});
    });
  });
});
