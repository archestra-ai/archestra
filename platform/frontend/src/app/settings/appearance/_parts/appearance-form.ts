import type { archestraApiTypes } from "@archestra/shared";
import type { ChatLinkEditorValue } from "./chat-links-editor.utils";
import { sanitizeChatLinks } from "./chat-links-editor.utils";
import type { OnboardingWizardValue } from "./onboarding-wizards-editor.utils";
import { sanitizeOnboardingWizard } from "./onboarding-wizards-editor.utils";

type Organization = archestraApiTypes.GetOrganizationResponses["200"];
type Notification =
  archestraApiTypes.GetSiteNotificationSettingsResponses["200"];
export type AppearanceDraft = Pick<
  Organization,
  | "logo"
  | "logoDark"
  | "iconLogo"
  | "iconLogoDark"
  | "favicon"
  | "theme"
  | "animateChatPlaceholders"
  | "slimChatErrorUi"
> & {
  appName: string;
  ogDescription: string;
  footerText: string;
  chatLinks: ChatLinkEditorValue[];
  chatPlaceholders: string[];
  onboardingWizard: OnboardingWizardValue | null;
  chatErrorSupportMessage: string;
  notificationContent: string;
  notificationExpiresAt: Date | null;
  notificationDeleted: boolean;
};

export function appearanceDefaults(
  organization: Organization,
  notification: Notification | undefined,
): AppearanceDraft {
  return {
    appName: organization.appName ?? "",
    ogDescription: organization.ogDescription ?? "",
    footerText: organization.footerText ?? "",
    theme: organization.theme,
    logo: organization.logo,
    logoDark: organization.logoDark,
    iconLogo: organization.iconLogo,
    iconLogoDark: organization.iconLogoDark,
    favicon: organization.favicon,
    chatLinks: organization.chatLinks ?? [],
    chatPlaceholders: organization.chatPlaceholders ?? [],
    animateChatPlaceholders: organization.animateChatPlaceholders,
    onboardingWizard: organization.onboardingWizard,
    chatErrorSupportMessage: organization.chatErrorSupportMessage ?? "",
    slimChatErrorUi: organization.slimChatErrorUi,
    notificationContent: notification?.content ?? "",
    notificationExpiresAt: notification?.expiresAt
      ? new Date(notification.expiresAt)
      : null,
    notificationDeleted: false,
  };
}

export function appearancePatch(
  draft: AppearanceDraft,
  dirty: Partial<Record<keyof AppearanceDraft, unknown>>,
): archestraApiTypes.UpdateAppearanceSettingsData["body"] {
  const patch: archestraApiTypes.UpdateAppearanceSettingsData["body"] = {};
  if (dirty.appName) patch.appName = draft.appName.trim() || null;
  if (dirty.ogDescription)
    patch.ogDescription = draft.ogDescription.trim() || null;
  if (dirty.footerText) patch.footerText = draft.footerText.trim() || null;
  if (dirty.theme) patch.theme = draft.theme;
  for (const field of [
    "logo",
    "logoDark",
    "iconLogo",
    "iconLogoDark",
    "favicon",
  ] as const) {
    if (dirty[field]) patch[field] = draft[field];
  }
  if (dirty.chatLinks) {
    const links = sanitizeChatLinks(draft.chatLinks);
    patch.chatLinks = links.length ? links : null;
  }
  if (dirty.chatPlaceholders) {
    const prompts = draft.chatPlaceholders
      .map((value) => value.trim())
      .filter(Boolean);
    patch.chatPlaceholders = prompts.length ? prompts : null;
  }
  if (dirty.animateChatPlaceholders)
    patch.animateChatPlaceholders = draft.animateChatPlaceholders;
  if (dirty.onboardingWizard) {
    const wizard = sanitizeOnboardingWizard(draft.onboardingWizard);
    patch.onboardingWizard = wizard
      ? {
          ...wizard,
          pages: wizard.pages.map((page) => ({
            ...page,
            image: page.image ?? null,
          })),
        }
      : null;
  }
  if (dirty.chatErrorSupportMessage)
    patch.chatErrorSupportMessage =
      draft.chatErrorSupportMessage.trim() || null;
  if (dirty.slimChatErrorUi) patch.slimChatErrorUi = draft.slimChatErrorUi;
  return patch;
}
