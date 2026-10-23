"use client";

import {
  type EncryptedChatRedactedContent,
  type EncryptedChatSealedContent,
  isEncryptedChatSealedContent,
  isLogContentNotStored,
} from "@archestra/shared";
import { EyeOff } from "lucide-react";
import { EncryptedChatIcon } from "@/components/chat/encrypted-chat-icon";
import { cn } from "@/lib/utils/tailwind";

type UnavailableContent =
  | EncryptedChatSealedContent
  | EncryptedChatRedactedContent;

/**
 * What the logs pages show in place of content they do not have. Three
 * states, each worded for what actually happened: an encrypted chat's content
 * still exists (encrypted, with an escrow copy of the key); an encrypted chat's
 * redacted content never made it to disk; and the deployment's Log Content
 * mode kept the content from being written at all.
 *
 * Locked content really is recoverable: the wrapped key sits on the
 * conversation row, so its presence is verifiable rather than assumed.
 */
export function EncryptedChatContentUnavailable({
  value,
  className,
}: {
  value: UnavailableContent;
  className?: string;
}) {
  const { title, body } = describeUnavailable(value);

  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-3 rounded-lg border border-dashed bg-muted/40 p-4",
        className,
      )}
    >
      <UnavailableIcon value={value} className="mt-0.5 size-5" />
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

/** The same states, for table cells where the full panel does not fit. */
export function EncryptedChatContentUnavailableLabel({
  value,
}: {
  value: UnavailableContent;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <UnavailableIcon value={value} className="size-3.5" />
      <span>
        {isEncryptedChatSealedContent(value) ? "Encrypted" : "Not stored"}
      </span>
    </span>
  );
}

// === Internal helpers ===

function describeUnavailable(value: UnavailableContent): {
  title: string;
  body: string;
} {
  if (isEncryptedChatSealedContent(value)) {
    return {
      title: "Encrypted chat content",
      body: "This content is encrypted with a key held only in the browser that started the chat. It can be recovered with the escrow key, which is held offline.",
    };
  }
  if (isLogContentNotStored(value)) {
    return {
      title: "Content not stored",
      body: "This was logged while Log Content was set to Metadata only, so the content was never stored.",
    };
  }
  return {
    title: "Content not stored",
    body: "This encrypted-chat content could not be encrypted when it was written, so it was never stored. It cannot be recovered.",
  };
}

function UnavailableIcon({
  value,
  className,
}: {
  value: UnavailableContent;
  className?: string;
}) {
  return isLogContentNotStored(value) ? (
    <EyeOff className={cn("text-muted-foreground", className)} />
  ) : (
    <EncryptedChatIcon className={className} />
  );
}
