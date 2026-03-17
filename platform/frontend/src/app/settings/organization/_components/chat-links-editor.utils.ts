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

  return {
    label:
      trimmedLabel.length === 0
        ? "Enter a label."
        : trimmedLabel.length > 25
          ? "Label must be 25 characters or fewer."
          : undefined,
    url:
      trimmedUrl.length === 0
        ? requireComplete
          ? "Enter a valid HTTP or HTTPS URL."
          : undefined
        : !isValidChatLinkUrl(trimmedUrl)
        ? "Enter a valid HTTP or HTTPS URL."
        : undefined,
  };
}
