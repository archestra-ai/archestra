"use client";

import type { ComponentProps } from "react";
import type * as BrowserPanelModule from "@/components/chat/browser-panel";
import type * as ChatMessagesModule from "@/components/chat/chat-messages";
import type * as FilesPanelModule from "@/components/chat/conversation-files-panel";
import type * as OnboardingWizardModule from "@/components/chat/onboarding-wizard-button";
import type * as RightPanelModule from "@/components/chat/right-side-panel";
import type * as DefaultModelModule from "@/components/default-model-onboarding";
import type * as NoApiKeyModule from "@/components/no-api-key-setup";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";

// Parts of the chat page that are not the composer. Each is its own chunk, so
// the new-chat screen's first load carries none of them, and none holds the
// composer's hydration: they mount when their chunk arrives. A conversation
// preloads the transcript as it mounts (preloadConversationParts).

export const ChatMessages = lazyComponent<
  ComponentProps<typeof ChatMessagesModule.ChatMessages>
>(() => import("@/components/chat/chat-messages").then((m) => m.ChatMessages));

export const ConversationFilesPanel = lazyComponent<
  ComponentProps<typeof FilesPanelModule.ConversationFilesPanel>
>(() =>
  import("@/components/chat/conversation-files-panel").then(
    (m) => m.ConversationFilesPanel,
  ),
);

export const BrowserPanel = lazyComponent<
  ComponentProps<typeof BrowserPanelModule.BrowserPanel>
>(() => import("@/components/chat/browser-panel").then((m) => m.BrowserPanel));

export const RightSidePanel = lazyComponent<
  ComponentProps<typeof RightPanelModule.RightSidePanel>
>(() =>
  import("@/components/chat/right-side-panel").then((m) => m.RightSidePanel),
);

export const AppsPanelContent = lazyComponent<
  ComponentProps<typeof RightPanelModule.AppsPanelContent>
>(() =>
  import("@/components/chat/right-side-panel").then((m) => m.AppsPanelContent),
);

export const OnboardingWizardButton = lazyComponent<
  ComponentProps<typeof OnboardingWizardModule.OnboardingWizardButton>
>(() =>
  import("@/components/chat/onboarding-wizard-button").then(
    (m) => m.OnboardingWizardButton,
  ),
);

export const NoApiKeySetup = lazyComponent<
  ComponentProps<typeof NoApiKeyModule.NoApiKeySetup>
>(() => import("@/components/no-api-key-setup").then((m) => m.NoApiKeySetup));

export const DefaultModelOnboardingStep = lazyComponent<
  ComponentProps<typeof DefaultModelModule.DefaultModelOnboardingStep>
>(() =>
  import("@/components/default-model-onboarding").then(
    (m) => m.DefaultModelOnboardingStep,
  ),
);

/** A conversation is about to render its transcript. */
export function preloadConversationParts(): void {
  void ChatMessages.preload();
}
