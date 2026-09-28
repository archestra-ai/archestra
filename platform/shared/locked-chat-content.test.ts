import { describe, expect, it } from "vitest";
import {
  isLockedChatRedactedContent,
  isLockedChatSealedContent,
  isLockedChatUnavailableContent,
  LOCKED_CHAT_REDACTED_MARKER,
  lockedChatSealedContent,
} from "./locked-chat-content";
import { logContentNotStored } from "./log-content";

describe("redacted content", () => {
  it("recognizes the marker it writes", () => {
    expect(isLockedChatRedactedContent(LOCKED_CHAT_REDACTED_MARKER)).toBe(true);
  });

  it("still recognizes rows redacted before the feature was renamed", () => {
    // Written as { __redacted: "incognito" }. Those rows are still on disk,
    // and misreading one would render it as real content rather than as
    // unavailable.
    expect(isLockedChatRedactedContent({ __redacted: "incognito" })).toBe(true);
    expect(isLockedChatUnavailableContent({ __redacted: "incognito" })).toBe(
      true,
    );
  });

  it("recognizes content the Log Content setting kept out of storage", () => {
    // Outside any locked chat, but it means the same to a reader: never
    // stored. Missing it would render the marker as a provider payload.
    const marker = logContentNotStored({ isError: true });

    expect(isLockedChatRedactedContent(marker)).toBe(true);
    expect(isLockedChatUnavailableContent(marker)).toBe(true);
    expect(isLockedChatSealedContent(marker)).toBe(false);
  });

  it("does not treat other redaction markers as its own", () => {
    expect(isLockedChatRedactedContent({ __redacted: "something-else" })).toBe(
      false,
    );
    expect(isLockedChatRedactedContent({ text: "hello" })).toBe(false);
    expect(isLockedChatRedactedContent(null)).toBe(false);
  });
});

describe("sealed content", () => {
  it("carries the conversation id so break-glass knows which key opens it", () => {
    const sealed = lockedChatSealedContent("conv-1");

    expect(sealed).toEqual({ __lockedChatSealed: "conv-1" });
    expect(isLockedChatSealedContent(sealed)).toBe(true);
    expect(isLockedChatUnavailableContent(sealed)).toBe(true);
    // Distinct from redacted: sealed content is recoverable, redacted is not.
    expect(isLockedChatRedactedContent(sealed)).toBe(false);
  });

  it("rejects shapes that are not the sealed marker", () => {
    expect(isLockedChatSealedContent({ __lockedChatSealed: 1 })).toBe(false);
    expect(isLockedChatSealedContent({})).toBe(false);
    expect(isLockedChatSealedContent(null)).toBe(false);
  });
});
