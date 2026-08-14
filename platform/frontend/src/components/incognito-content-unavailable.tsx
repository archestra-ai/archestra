"use client";

import {
  type IncognitoLockedContent,
  type IncognitoRedactedContent,
  isIncognitoLockedContent,
} from "@archestra/shared";
import { IncognitoIcon } from "@/components/chat/incognito-icon";
import { cn } from "@/lib/utils";

type UnavailableContent = IncognitoLockedContent | IncognitoRedactedContent;

/**
 * What the logs pages show in place of an incognito conversation's audit
 * content. The two states are deliberately worded differently: locked content
 * still exists (encrypted, with an escrow copy of the key), redacted content
 * never made it to disk.
 *
 * Locked content really is recoverable: the wrapped key sits on the
 * conversation row, so its presence is verifiable rather than assumed.
 */
export function IncognitoContentUnavailable({
  value,
  className,
}: {
  value: UnavailableContent;
  className?: string;
}) {
  const locked = isIncognitoLockedContent(value);

  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-3 rounded-lg border border-dashed bg-muted/40 p-4",
        className,
      )}
    >
      <IncognitoIcon className="mt-0.5 size-5" />
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {locked ? "Encrypted locked-chat content" : "Content not stored"}
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {locked
            ? "This content is encrypted with a key held only in the browser that started the chat. It can be recovered with the escrow key, which is held offline."
            : "This locked-chat content could not be encrypted when it was written, so it was never stored. It cannot be recovered."}
        </p>
      </div>
    </div>
  );
}

/** The same two states, for table cells where the full panel does not fit. */
export function IncognitoContentUnavailableLabel({
  value,
}: {
  value: UnavailableContent;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <IncognitoIcon className="size-3.5" />
      <span>
        {isIncognitoLockedContent(value) ? "Encrypted" : "Not stored"}
      </span>
    </span>
  );
}
