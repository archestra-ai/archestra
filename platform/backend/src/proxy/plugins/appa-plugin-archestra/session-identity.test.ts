import { describe, expect, test } from "@/test";
import { extractAppaSessionIdentity } from "./session-identity";

const CLAUDE_SESSION = "74582997-cc91-4cd5-baee-676e581ca028";
const CLAUDE_FORK_SESSION = "8f3c1e2a-9b4d-4c7e-a1f2-3d4e5f6a7b8c";

const CODEX_SESSION = "d12f967d-6fe1-4f92-a62f-0f6a2092fd2f";
const CODEX_RESUMED_SESSION = "f5be22fa-3d3a-44ce-8d37-d0073acd5174";
const CODEX_THREAD = "01a0859b-3029-78f3-a730-0edef60872cb";
const CODEX_FORK_THREAD = "01a085a0-ca43-7671-9450-8508eddef38d";

const OPENCODE_SESSION = "ses_01J8ZQ3V0R1Y8M0P4K0W3M7P9A";
const OPENCODE_FORK_SESSION = "ses_01J8ZQ7K2M4N6P8R0T2W4Y6A8C";

const codexHeaders = {
  "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
  originator: "codex_cli_rs",
};
const openCodeHeaders = { "user-agent": "opencode/1.18.29" };

const codexTurnMetadata = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  session_id: CODEX_SESSION,
  thread_id: CODEX_THREAD,
  turn_id: "turn-1",
  window_id: "win-1",
  ...overrides,
});

describe("client trajectory identity", () => {
  describe("explicit header", () => {
    test("an explicit X-Appa-Session-ID outranks every client-native signal", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { client_metadata: codexTurnMetadata() },
          headers: {
            ...codexHeaders,
            "x-appa-session-id": "operator-root",
            "x-appa-parent-id": "parent-root",
          },
        }),
      ).toMatchObject({
        sessionId: "operator-root",
        parentId: "parent-root",
        provenance: "appa-header",
      });
    });
  });

  describe("Claude Code", () => {
    test("a session resumes and compacts on one root; a fork opens a fresh one", () => {
      const resume = extractAppaSessionIdentity({
        family: "anthropic:messages",
        body: {},
        headers: { "x-claude-code-session-id": CLAUDE_SESSION },
      });
      // A fork mints a new session id client-side; nothing else changes.
      const fork = extractAppaSessionIdentity({
        family: "anthropic:messages",
        body: {},
        headers: { "x-claude-code-session-id": CLAUDE_FORK_SESSION },
      });

      expect(resume).toMatchObject({
        sessionId: CLAUDE_SESSION,
        provenance: "claude-code-header",
      });
      expect(fork.sessionId).toBe(CLAUDE_FORK_SESSION);
      expect(fork.sessionId).not.toBe(resume.sessionId);
    });

    test("falls back to the metadata.user_id session when the header is absent", () => {
      expect(
        extractAppaSessionIdentity({
          family: "anthropic:messages",
          body: {
            metadata: {
              user_id: JSON.stringify({
                device_id: "3d8b2867632db5c0",
                account_uuid: "",
                session_id: CLAUDE_SESSION,
              }),
            },
          },
          headers: { "user-agent": "claude-code/2.1.258" },
        }),
      ).toMatchObject({
        sessionId: CLAUDE_SESSION,
        provenance: "claude-metadata",
      });
    });

    test("keeps an X-Appa-Parent-ID alongside the native session", () => {
      expect(
        extractAppaSessionIdentity({
          family: "anthropic:messages",
          body: {},
          headers: {
            "x-claude-code-session-id": CLAUDE_SESSION,
            "x-appa-parent-id": "parent-root",
          },
        }),
      ).toMatchObject({
        sessionId: CLAUDE_SESSION,
        parentId: "parent-root",
      });
    });
  });

  describe("Codex", () => {
    test("roots on the durable thread id, not the per-run session id", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { client_metadata: codexTurnMetadata() },
          headers: codexHeaders,
        }),
      ).toMatchObject({
        sessionId: CODEX_THREAD,
        provenance: "codex-turn-metadata",
      });
    });

    test("a resume under a fresh session id reopens the thread's root", () => {
      const firstRun = extractAppaSessionIdentity({
        family: "openai:responses",
        body: { client_metadata: codexTurnMetadata() },
        headers: codexHeaders,
      });
      const resumed = extractAppaSessionIdentity({
        family: "openai:responses",
        body: {
          client_metadata: codexTurnMetadata({
            session_id: CODEX_RESUMED_SESSION,
          }),
        },
        headers: codexHeaders,
      });

      expect(resumed.sessionId).toBe(firstRun.sessionId);
    });

    test("a fork opens a fresh root under its new thread id", () => {
      const parent = extractAppaSessionIdentity({
        family: "openai:responses",
        body: { client_metadata: codexTurnMetadata() },
        headers: codexHeaders,
      });
      const fork = extractAppaSessionIdentity({
        family: "openai:responses",
        body: {
          client_metadata: codexTurnMetadata({
            thread_id: CODEX_FORK_THREAD,
            forked_from_thread_id: CODEX_THREAD,
            forked_from_ordinal_exclusive: 12,
          }),
        },
        headers: codexHeaders,
      });

      expect(fork.sessionId).toBe(CODEX_FORK_THREAD);
      expect(fork.sessionId).not.toBe(parent.sessionId);
    });

    test("a compaction turn stays on the thread's root", () => {
      const before = extractAppaSessionIdentity({
        family: "openai:responses",
        body: { client_metadata: codexTurnMetadata() },
        headers: codexHeaders,
      });
      const compactionTurn = extractAppaSessionIdentity({
        family: "openai:responses",
        body: {
          client_metadata: codexTurnMetadata({
            request_kind: "compaction",
          }),
        },
        headers: { ...codexHeaders, "x-openai-subagent": "compact" },
      });

      expect(compactionTurn.sessionId).toBe(before.sessionId);
    });

    test("reads the canonical turn-metadata blob under client_metadata", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: {
            client_metadata: {
              "x-codex-turn-metadata": codexTurnMetadata(),
            },
          },
          headers: codexHeaders,
        }),
      ).toMatchObject({
        sessionId: CODEX_THREAD,
        provenance: "codex-turn-metadata",
      });
    });

    test("reads the JSON turn-metadata blob from the compat header", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: {},
          headers: {
            ...codexHeaders,
            "x-codex-turn-metadata": JSON.stringify(codexTurnMetadata()),
          },
        }),
      ).toMatchObject({
        sessionId: CODEX_THREAD,
        provenance: "codex-turn-metadata",
      });
    });

    test("detects a Codex request from client_metadata alone", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { client_metadata: codexTurnMetadata() },
          headers: {},
        }),
      ).toMatchObject({
        sessionId: CODEX_THREAD,
        provenance: "codex-turn-metadata",
      });
    });

    test("falls back to the flat session-id header of an older Codex", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: {},
          headers: { ...codexHeaders, "session-id": CODEX_SESSION },
        }),
      ).toMatchObject({
        sessionId: CODEX_SESSION,
        provenance: "codex-turn-metadata",
      });
    });

    test("refuses contradictory turn metadata across the body and the header", () => {
      expect(() =>
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { client_metadata: codexTurnMetadata() },
          headers: {
            ...codexHeaders,
            "x-codex-turn-metadata": JSON.stringify(
              codexTurnMetadata({ thread_id: CODEX_FORK_THREAD }),
            ),
          },
        }),
      ).toThrow(/contradictory Codex trajectory metadata/);
    });

    test("refuses malformed turn metadata on the header", () => {
      expect(() =>
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: {},
          headers: { ...codexHeaders, "x-codex-turn-metadata": "{not json" },
        }),
      ).toThrow(/malformed Codex trajectory metadata/);
    });

    test("a Codex request without turn metadata keeps the generic fallbacks", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { prompt_cache_key: "cache-partition-1" },
          headers: codexHeaders,
        }),
      ).toMatchObject({
        sessionId: "cache-partition-1",
        provenance: "prompt-cache-key",
      });
    });
  });

  describe("OpenCode", () => {
    test("roots on the session id from X-Session-Id", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:chatCompletions",
          body: {},
          headers: { ...openCodeHeaders, "x-session-id": OPENCODE_SESSION },
        }),
      ).toMatchObject({
        sessionId: OPENCODE_SESSION,
        provenance: "opencode-session-header",
      });
    });

    test("accepts x-session-affinity repeating the same session id", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:chatCompletions",
          body: {},
          headers: {
            ...openCodeHeaders,
            "x-session-id": OPENCODE_SESSION,
            "x-session-affinity": OPENCODE_SESSION,
          },
        }),
      ).toMatchObject({ sessionId: OPENCODE_SESSION });
    });

    test("a fork opens a fresh root under its new session id", () => {
      const parent = extractAppaSessionIdentity({
        family: "openai:chatCompletions",
        body: {},
        headers: { ...openCodeHeaders, "x-session-id": OPENCODE_SESSION },
      });
      const fork = extractAppaSessionIdentity({
        family: "openai:chatCompletions",
        body: {},
        headers: {
          ...openCodeHeaders,
          "x-session-id": OPENCODE_FORK_SESSION,
        },
      });

      expect(fork.sessionId).toBe(OPENCODE_FORK_SESSION);
      expect(fork.sessionId).not.toBe(parent.sessionId);
    });

    test("a compaction request stays on the session's root", () => {
      const before = extractAppaSessionIdentity({
        family: "openai:chatCompletions",
        body: { messages: [{ role: "user", content: "hi" }] },
        headers: { ...openCodeHeaders, "x-session-id": OPENCODE_SESSION },
      });
      // OpenCode compaction flattens history into a tool-less text request
      // inside the same session.
      const compaction = extractAppaSessionIdentity({
        family: "openai:chatCompletions",
        body: {
          messages: [
            {
              role: "user",
              content:
                "Summarize: user asked about the weather; get_remedy_plans ruling …",
            },
          ],
        },
        headers: { ...openCodeHeaders, "x-session-id": OPENCODE_SESSION },
      });

      expect(compaction.sessionId).toBe(before.sessionId);
    });

    test("reads the hosted-provider session header", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:chatCompletions",
          body: {},
          headers: {
            ...openCodeHeaders,
            "x-opencode-session": OPENCODE_SESSION,
          },
        }),
      ).toMatchObject({
        sessionId: OPENCODE_SESSION,
        provenance: "opencode-hosted-header",
      });
    });

    test("refuses contradictory session headers", () => {
      expect(() =>
        extractAppaSessionIdentity({
          family: "openai:chatCompletions",
          body: {},
          headers: {
            ...openCodeHeaders,
            "x-session-id": OPENCODE_SESSION,
            "x-session-affinity": OPENCODE_FORK_SESSION,
          },
        }),
      ).toThrow(/contradictory OpenCode session headers/);
    });

    test("refuses a hosted header contradicting the normal one", () => {
      expect(() =>
        extractAppaSessionIdentity({
          family: "openai:chatCompletions",
          body: {},
          headers: {
            ...openCodeHeaders,
            "x-session-id": OPENCODE_SESSION,
            "x-opencode-session": OPENCODE_FORK_SESSION,
          },
        }),
      ).toThrow(/contradictory OpenCode session headers/);
    });

    test("a bare x-session-id is never attributed without OpenCode evidence", () => {
      const identity = extractAppaSessionIdentity({
        family: "openai:chatCompletions",
        body: {},
        headers: { "x-session-id": OPENCODE_SESSION },
      });

      expect(identity.sessionId).toBeUndefined();
      expect(identity.provenance).toBe("none");
    });
  });

  describe("generic clients", () => {
    test("keeps the wire-family fallbacks when no adapter matches", () => {
      expect(
        extractAppaSessionIdentity({
          family: "openai:responses",
          body: { metadata: { session_id: "s-2" } },
          headers: {},
        }),
      ).toMatchObject({
        sessionId: "s-2",
        provenance: "metadata-session-id",
      });
    });

    test("keeps the Anthropic metadata fallback when Claude Code's header is absent", () => {
      expect(
        extractAppaSessionIdentity({
          family: "anthropic:messages",
          body: { metadata: { user_id: "tenant-42" } },
          headers: {},
        }),
      ).toMatchObject({
        sessionId: "tenant-42",
        provenance: "claude-metadata",
      });
    });
  });
});
