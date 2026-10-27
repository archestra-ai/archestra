"use client";

import type { ReactNode } from "react";
import type { UseFormReturn } from "react-hook-form";
import { FieldDescription } from "@/components/ui/field-description";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AppearanceDraft } from "./appearance-form";
import type { AppearanceSectionId } from "./appearance-pages";
import { BrandingAssets, BrandingPalette } from "./branding-controls";
import {
  ChatErrorSettings,
  ChatPrompts,
  ChatShortcutLinks,
} from "./chat-controls";
import { validateChatLink } from "./chat-links-editor.utils";
import { validateOnboardingWizard } from "./onboarding-wizards-editor.utils";
import { OnboardingGuide, SiteAnnouncement } from "./welcome-controls";

export function AppearanceEditor({
  id,
  form,
  canEdit,
  showErrors,
}: {
  id: AppearanceSectionId;
  form: UseFormReturn<AppearanceDraft>;
  canEdit: boolean;
  showErrors: boolean;
}) {
  const draft = form.watch();
  const change = <K extends keyof AppearanceDraft>(
    field: K,
    value: AppearanceDraft[K],
  ) => {
    if (canEdit) form.setValue(field, value as never, { shouldDirty: true });
  };
  let content: ReactNode;
  switch (id) {
    case "brand":
      content = (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Brand details</Label>
            <FieldDescription>
              The text people see in browser tabs, shared links, and the footer.
            </FieldDescription>
          </div>
          <div className="space-y-2">
            <Label htmlFor="appearance-app-name">App Name</Label>
            <FieldDescription id="appearance-app-name-description">
              Browser title and built-in MCP server and tool names.
            </FieldDescription>
            <Input
              id="appearance-app-name"
              aria-describedby="appearance-app-name-description"
              {...form.register("appName")}
              maxLength={100}
              placeholder="Default app name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="appearance-description">
              OpenGraph Description
            </Label>
            <FieldDescription id="appearance-description-description">
              Shown when someone shares a platform link.
            </FieldDescription>
            <Textarea
              id="appearance-description"
              aria-describedby="appearance-description-description"
              {...form.register("ogDescription")}
              maxLength={500}
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="appearance-footer">Footer Text</Label>
            <FieldDescription id="appearance-footer-description">
              Custom text shown in the footer alongside the version number.
            </FieldDescription>
            <Input
              id="appearance-footer"
              aria-describedby="appearance-footer-description"
              {...form.register("footerText")}
              maxLength={500}
              placeholder="Leave empty to show the version number"
            />
          </div>
        </div>
      );
      break;
    case "theme":
      content = (
        <BrandingPalette
          value={draft.theme}
          disabled={!canEdit}
          onChange={(value) =>
            change("theme", value as AppearanceDraft["theme"])
          }
        />
      );
      break;
    case "logos":
      content = (
        <BrandingAssets
          values={draft}
          disabled={!canEdit}
          onChange={(field, value) => change(field, value)}
        />
      );
      break;
    case "placeholders":
      content = (
        <ChatPrompts
          values={draft.chatPlaceholders ?? []}
          animated={draft.animateChatPlaceholders}
          disabled={!canEdit}
          onChange={(value) => change("chatPlaceholders", value)}
          onAnimationChange={(value) =>
            change("animateChatPlaceholders", value)
          }
        />
      );
      break;
    case "links":
      content = (
        <ChatShortcutLinks
          values={draft.chatLinks ?? []}
          errors={(draft.chatLinks ?? []).map((link) =>
            validateChatLink(link, { requireComplete: showErrors }),
          )}
          disabled={!canEdit}
          onChange={(value) => change("chatLinks", value)}
        />
      );
      break;
    case "onboarding":
      content = (
        <OnboardingGuide
          wizard={draft.onboardingWizard}
          errors={validateOnboardingWizard(draft.onboardingWizard, {
            requireComplete: showErrors,
          })}
          disabled={!canEdit}
          onChange={(value) =>
            change(
              "onboardingWizard",
              value as AppearanceDraft["onboardingWizard"],
            )
          }
        />
      );
      break;
    case "support":
      content = (
        <ChatErrorSettings
          message={draft.chatErrorSupportMessage ?? ""}
          simplified={draft.slimChatErrorUi}
          disabled={!canEdit}
          onMessageChange={(value) => change("chatErrorSupportMessage", value)}
          onSimplifiedChange={(value) => change("slimChatErrorUi", value)}
        />
      );
      break;
    case "notification":
      content = (
        <SiteAnnouncement
          content={draft.notificationContent}
          expiresAt={draft.notificationExpiresAt}
          disabled={!canEdit}
          onChange={(content, expiresAt) => {
            change("notificationContent", content);
            change("notificationExpiresAt", expiresAt);
            change("notificationDeleted", false);
          }}
          onRemove={() => {
            change("notificationContent", "");
            change("notificationExpiresAt", null);
            change("notificationDeleted", true);
          }}
        />
      );
      break;
  }
  return (
    <fieldset
      disabled={!canEdit && id !== "onboarding" && id !== "notification"}
      className="min-w-0"
    >
      {content}
    </fieldset>
  );
}
