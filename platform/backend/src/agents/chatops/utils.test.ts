import { describe, expect, test } from "vitest";
import {
  buildAgentFooter,
  buildHistorySkippedAttachmentsNote,
  buildSkippedAttachmentsNote,
  formatApprovalToolArgs,
  isLlmProviderAuthError,
  Semaphore,
  stripAgentFooterChrome,
  stripDuplicateAgentFooter,
} from "./utils";

describe("buildAgentFooter", () => {
  test("is just the agent identity when there is no extra detail", () => {
    expect(buildAgentFooter("Sales Bot")).toBe("🤖 Sales Bot");
  });

  test("trails extra detail after the agent identity", () => {
    expect(buildAgentFooter("Sales Bot", "invalid x-api-key")).toBe(
      "🤖 Sales Bot · invalid x-api-key",
    );
  });
});

describe("stripDuplicateAgentFooter", () => {
  const footer = buildAgentFooter("Sales Bot");

  test("drops a footer the model wrote itself so ours is the only one", () => {
    expect(
      stripDuplicateAgentFooter("Here you go.\n\n🤖 Sales Bot", footer),
    ).toBe("Here you go.");
  });

  test("drops repeats, so a reply can never carry two branding lines", () => {
    expect(
      stripDuplicateAgentFooter(
        "Here you go.\n\n🤖 Sales Bot\n\n🤖 Sales Bot",
        footer,
      ),
    ).toBe("Here you go.");
  });

  test("drops the markdown rule the echo sits under", () => {
    expect(
      stripDuplicateAgentFooter("Here you go.\n\n---\n\n🤖 Sales Bot", footer),
    ).toBe("Here you go.");
  });

  test("drops an echo wrapped in markdown emphasis", () => {
    expect(
      stripDuplicateAgentFooter("Here you go.\n\n_🤖 Sales Bot_", footer),
    ).toBe("Here you go.");
    expect(
      stripDuplicateAgentFooter("Here you go.\n\n**🤖 Sales Bot**", footer),
    ).toBe("Here you go.");
  });

  test("drops an echo of an error footer, detail and all", () => {
    const errorFooter = buildAgentFooter("Sales Bot", "invalid x-api-key");
    expect(
      stripDuplicateAgentFooter(
        `Something broke.\n\n${errorFooter}`,
        errorFooter,
      ),
    ).toBe("Something broke.");
  });

  test("drops a bare identity echo even when ours carries error detail", () => {
    expect(
      stripDuplicateAgentFooter(
        "Something broke.\n\n🤖 Sales Bot",
        buildAgentFooter("Sales Bot", "upstream exploded"),
      ),
    ).toBe("Something broke.");
  });

  test("leaves a reply that never signed off untouched", () => {
    expect(stripDuplicateAgentFooter("Here you go.", footer)).toBe(
      "Here you go.",
    );
  });

  test("keeps content that merely mentions the glyph or another agent", () => {
    // Only an exact duplicate of the footer being appended is chrome — this
    // runs on user-visible text, where a false positive eats the answer.
    for (const text of [
      "Bots I know:\n\n🤖 Sales Bot handles quotes.",
      "Here you go.\n\n🤖 Support Bot",
      "Here you go.\n\n🤖 Sales Bot\n\nOne more thing.",
    ]) {
      expect(stripDuplicateAgentFooter(text, footer)).toBe(text);
    }
  });

  test("strips an echo spelled with the provider's emoji shortcode", () => {
    // We post the literal glyph, but Slack stores emoji in colon notation, so
    // that is the spelling the model is replayed — and the one it copies.
    expect(
      stripDuplicateAgentFooter(
        "Here you go.\n\n:robot_face: Sales Bot",
        footer,
      ),
    ).toBe("Here you go.");
  });

  test("strips an echo run onto the end of the last sentence", () => {
    // The model does not always give its sign-off a line of its own; glued to
    // the prose it renders as a second branding line just the same.
    expect(
      stripDuplicateAgentFooter("That's the whole plan. 🤖 Sales Bot", footer),
    ).toBe("That's the whole plan.");
    expect(
      stripDuplicateAgentFooter(
        "That's the whole plan. :robot_face: Sales Bot",
        footer,
      ),
    ).toBe("That's the whole plan.");
  });

  test("strips a run-on echo and a lingering footer line together", () => {
    expect(
      stripDuplicateAgentFooter(
        "That's the whole plan. :robot_face: Sales Bot\n\n:robot_face: Sales Bot",
        footer,
      ),
    ).toBe("That's the whole plan.");
  });
});

describe("stripAgentFooterChrome", () => {
  test("strips the footer from a Slack bot turn", () => {
    expect(stripAgentFooterChrome("Here you go.\n\n🤖 Sales Bot")).toBe(
      "Here you go.",
    );
  });

  test("strips the footer and its rule from an MS Teams bot turn", () => {
    expect(stripAgentFooterChrome("Here you go.\n\n---\n\n🤖 Sales Bot")).toBe(
      "Here you go.",
    );
  });

  test("strips every footer, so a doubled reply stops teaching the pattern", () => {
    // The self-reinforcing case: replaying one surviving footer is what makes
    // the next turn sign off the same way.
    expect(
      stripAgentFooterChrome("Here you go.\n\n🤖 Sales Bot\n\n🤖 Sales Bot"),
    ).toBe("Here you go.");
  });

  test("strips a footer followed by trailing whitespace", () => {
    expect(stripAgentFooterChrome("Here you go.\n\n🤖 Sales Bot\n")).toBe(
      "Here you go.",
    );
  });

  test("strips an error footer whose detail spilled onto more lines", () => {
    expect(
      stripAgentFooterChrome(
        "Sorry, I encountered an error.\n\n🤖 Sales Bot · Error: boom\n  at handler()",
      ),
    ).toBe("Sorry, I encountered an error.");
  });

  test("strips a turn that is nothing but the footer", () => {
    expect(stripAgentFooterChrome("🤖 Sales Bot")).toBe("");
  });

  test("strips the footer in the spelling the provider actually returns", () => {
    // Slack normalizes emoji on storage, so a bot turn read back through the
    // API carries ":robot_face:" where we posted "🤖". Missing this spelling
    // replays a footer to the model on every single Slack turn.
    expect(
      stripAgentFooterChrome("Here you go.\n\n:robot_face: Sales Bot"),
    ).toBe("Here you go.");
    expect(
      stripAgentFooterChrome(
        "Here you go.\n\n:robot_face: Sales Bot\n:robot_face: Sales Bot",
      ),
    ).toBe("Here you go.");
  });

  test("strips a sign-off run onto the end of the last sentence", () => {
    expect(
      stripAgentFooterChrome("That's the whole plan. :robot_face: Sales Bot"),
    ).toBe("That's the whole plan.");
  });

  test("leaves no branding in a turn that already rendered two footers", () => {
    // The exact shape a doubled Slack reply comes back as: the model's run-on
    // echo, then the footer the platform appended.
    const turn =
      "It's purely an enrollment gate. :robot_face: Sales Bot\n\n:robot_face: Sales Bot";
    const cleaned = stripAgentFooterChrome(turn);
    expect(cleaned).toBe("It's purely an enrollment gate.");
    expect(cleaned).not.toContain("robot_face");
    expect(cleaned).not.toContain("🤖");
  });

  test("leaves no glyph behind on a final line that carries several", () => {
    // Sanitation is worth nothing if it hands the model back something to copy.
    expect(
      stripAgentFooterChrome("Bots up: 🤖 alpha and 🤖 beta\n\n🤖 Sales Bot"),
    ).toBe("Bots up:");
  });

  test("leaves a bot turn without chrome untouched", () => {
    expect(stripAgentFooterChrome("Here you go.")).toBe("Here you go.");
  });
});

describe("isLlmProviderAuthError", () => {
  test.each([
    "invalid x-api-key",
    "Incorrect API key provided: sk-abc***. You can find your API key at https://platform.openai.com/account/api-keys.",
    "API key not valid. Please pass a valid API key.",
    '{"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}',
    "Authentication failed",
    "invalid_api_key",
  ])("matches provider auth failure: %s", (message) => {
    expect(isLlmProviderAuthError(message)).toBe(true);
  });

  test.each([
    "network timeout",
    "Unauthorized: user does not have access to this agent",
    "tool execution failed with status 401",
    "rate limit exceeded",
    "model overloaded, please retry",
  ])("does not match unrelated error: %s", (message) => {
    expect(isLlmProviderAuthError(message)).toBe(false);
  });
});

describe("formatApprovalToolArgs", () => {
  test("pretty-prints a non-empty arguments object", () => {
    const out = formatApprovalToolArgs({ repo: "octo/repo", count: 3 });
    expect(out).toBe('{\n  "repo": "octo/repo",\n  "count": 3\n}');
  });

  test("returns null for undefined or empty arguments", () => {
    expect(formatApprovalToolArgs(undefined)).toBeNull();
    expect(formatApprovalToolArgs({})).toBeNull();
  });

  test("truncates output that exceeds the max length", () => {
    const out = formatApprovalToolArgs({ blob: "x".repeat(5000) }, 100);
    expect(out).not.toBeNull();
    // 100 chars of JSON + the truncation marker.
    expect(out?.length).toBe(100 + "\n… (truncated)".length);
    expect(out?.endsWith("\n… (truncated)")).toBe(true);
  });

  test("returns null when arguments cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatApprovalToolArgs(circular)).toBeNull();
  });
});

describe("buildSkippedAttachmentsNote", () => {
  test("returns empty string when nothing was skipped", () => {
    expect(buildSkippedAttachmentsNote([])).toBe("");
  });

  test("names each skipped file so the model knows it existed", () => {
    const note = buildSkippedAttachmentsNote([
      { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      { name: "notes.zip", reason: "download_failed" },
    ]);
    expect(note).not.toBe("");
    expect(note).toContain("IMG_0354.png");
    expect(note).toContain("notes.zip");
  });

  test("handles an unnamed file without throwing", () => {
    const note = buildSkippedAttachmentsNote([{ reason: "too_large" }]);
    expect(note).not.toBe("");
  });
});

describe("buildHistorySkippedAttachmentsNote", () => {
  test("returns empty string when nothing was skipped", () => {
    expect(buildHistorySkippedAttachmentsNote([])).toBe("");
  });

  test("names each skipped file so the model knows it existed", () => {
    const note = buildHistorySkippedAttachmentsNote([
      { name: "IMG_0354.png", sizeBytes: 16_562_518, reason: "too_large" },
      { name: "notes.zip", reason: "download_failed" },
    ]);
    expect(note).not.toBe("");
    expect(note).toContain("IMG_0354.png");
    expect(note).toContain("notes.zip");
  });

  test("handles an unnamed file without throwing", () => {
    const note = buildHistorySkippedAttachmentsNote([{ reason: "too_large" }]);
    expect(note).not.toBe("");
  });
});

describe("Semaphore", () => {
  /** Flush the microtask queue so settled promises run their callbacks. */
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /** Wrap a promise with a flag that flips once it settles. */
  const track = (promise: Promise<void>) => {
    const state = { settled: false };
    void promise.then(() => {
      state.settled = true;
    });
    return state;
  };

  test("blocks acquires beyond maxConcurrent until a release", async () => {
    const semaphore = new Semaphore(2);
    await semaphore.acquire();
    await semaphore.acquire();

    const third = track(semaphore.acquire());
    await flush();
    expect(third.settled).toBe(false);

    semaphore.release();
    await flush();
    expect(third.settled).toBe(true);
  });

  test("resumes waiters in FIFO order", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();

    const order: number[] = [];
    void semaphore.acquire().then(() => order.push(1));
    void semaphore.acquire().then(() => order.push(2));

    semaphore.release();
    await flush();
    expect(order).toEqual([1]);

    semaphore.release();
    await flush();
    expect(order).toEqual([1, 2]);
  });

  test("release with no waiters frees a permit for a later acquire", async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    semaphore.release();

    // Permit was returned to the pool, so both re-acquire and blocking work.
    await semaphore.acquire();
    const second = track(semaphore.acquire());
    await flush();
    expect(second.settled).toBe(false);
    semaphore.release();
    await flush();
    expect(second.settled).toBe(true);
  });

  test("stays usable after a throwing acquire/release cycle", async () => {
    const semaphore = new Semaphore(1);

    await expect(
      (async () => {
        await semaphore.acquire();
        try {
          throw new Error("boom");
        } finally {
          semaphore.release();
        }
      })(),
    ).rejects.toThrow("boom");

    const next = track(semaphore.acquire());
    await flush();
    expect(next.settled).toBe(true);
  });
});
