import { isValidChatLinkUrl } from "@/lib/chat-links";

export interface ChatLinkEditorValue {
  label: string;
  url: string;
}

export interface ChatLinkValidationError {
  label?: string;
  url?: string;
}

interface ValidateChatLinkOptions {
  requireComplete?: boolean;
}

export function sanitizeChatLinks(
  links: ChatLinkEditorValue[],
): ChatLinkEditorValue[] {
  return links
    .map((link) => ({
      label: link.label.trim(),
      url: link.url.trim(),
    }))
    .filter((link) => link.label.length > 0 || link.url.length > 0);
}

export function validateChatLink(
  link: ChatLinkEditorValue,
  options?: ValidateChatLinkOptions,
): ChatLinkValidationError {
  const trimmedLabel = link.label.trim();
  const trimmedUrl = link.url.trim();
  const requireComplete = options?.requireComplete ?? false;

  if (trimmedLabel.length === 0 && trimmedUrl.length === 0) {
    return {};
  }

  const validationErrors: ChatLinkValidationError = {};

  if (trimmedLabel.length === 0) {
    validationErrors.label = "Enter a label.";
  } else if (trimmedLabel.length > 25) {
    validationErrors.label = "Label must be 25 characters or fewer.";
  }

  if (trimmedUrl.length === 0) {
    if (requireComplete) {
      validationErrors.url = "Enter a valid HTTP or HTTPS URL.";
    }
  } else if (!isValidChatLinkUrl(trimmedUrl)) {
    validationErrors.url = "Enter a valid HTTP or HTTPS URL.";
  }

  return validationErrors;
}
