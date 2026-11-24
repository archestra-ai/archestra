import { OPENCODE_AGENT_HEADER } from "@archestra/shared/consts";
import {
  CLAUDE_CLIENT_ID,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_DESKTOP_CLIENT_ID,
} from "@archestra/shared/interactions/client";
import { describe, expect, test } from "vitest";
import { classifyAutoRoutingHousekeeping } from "./housekeeping";

const OPENCODE_AGENT_HEADER_KEY = OPENCODE_AGENT_HEADER.toLowerCase();

const TITLE_SYSTEM_PROMPT =
  "You write short session titles. Reply with only the tagged fields the prompt asks for.";
const PROGRESS_LABEL_SYSTEM_PROMPT =
  "You write a 3-5 word progress label for a background agent, from short notes about what it is doing.";
const PROGRESS_LABEL_USER_FRAME =
  "Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.\nGood: Reading auth middleware";
const PROGRESS_LABEL_AGENT_FRAME =
  "Describe the agent's most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch.\n\nGood: Running unit tests";
const AWAY_SUMMARY_FRAME =
  "The user stepped away and is coming back. Recap in under 40 words what we are working on.";
const SIDE_QUESTION_FRAME =
  "<system-reminder>This is a side question from the user. You must answer this question directly in a single response.</system-reminder>What is 2+2?";

const CLAUDE_COMPACTION =
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests.";
const CLAUDE_CRITICAL_COMPACTION =
  "CRITICAL: Respond with TEXT ONLY. Your task is to create a detailed summary of the conversation so far.";
const KIMI_COMPACTION =
  "You are about to run out of context. Create a handoff summary for the\nmodel that will resume this task after the earlier conversation is cleared.";

describe("classifyAutoRoutingHousekeeping", () => {
  describe("header-based allowlist", () => {
    test("matches OpenCode and Kilo title turns and excludes non-OpenCode clients", () => {
      for (const client of ["opencode", "kilo"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: { [OPENCODE_AGENT_HEADER_KEY]: "title" },
            body: { messages: [{ role: "user", content: "Generate title" }] },
            client,
          }),
        ).toBe("opencode_title");
      }

      for (const client of [null, "codex"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: { [OPENCODE_AGENT_HEADER_KEY]: "title" },
            body: { messages: [{ role: "user", content: "Generate title" }] },
            client,
          }),
        ).toBeNull();
      }
    });

    test("matches Claude Code auxiliary/side_reply headers only with exact Claude provenance", () => {
      for (const value of ["auxiliary", "side_reply"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: { "x-claude-code-request-class": value },
            body: { messages: [{ role: "user", content: "Helper task" }] },
            client: CLAUDE_CODE_CLIENT_ID,
          }),
        ).toBe("claude_auxiliary_header");
      }

      // Billing header in body also establishes Claude provenance.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: {
            system: "x-anthropic-billing-header: cc_entrypoint=claude-code",
            messages: [{ role: "user", content: "Helper task" }],
          },
          client: null,
        }),
      ).toBe("claude_auxiliary_header");

      // Non-Claude clients and arbitrary `claude-*` labels are rejected.
      for (const client of [null, "opencode", "codex", "claude-eval-proxy"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: { "x-claude-code-request-class": "auxiliary" },
            body: { messages: [{ role: "user", content: "Helper task" }] },
            client,
          }),
        ).toBeNull();
      }
    });
  });

  describe("prompt allowlist on Chat Completions and stateless Responses", () => {
    test("matches title_system_prompt on text-only single-turn requests and rejects overridden, multi-turn, or image turns", () => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: [
              {
                type: "text",
                text: "x-anthropic-billing-header: cc_entrypoint=claude-code",
              },
              { type: "text", text: TITLE_SYSTEM_PROMPT },
            ],
            messages: [
              { role: "user", content: "<conversation>hello</conversation>" },
            ],
          },
          client: null,
        }),
      ).toBe("title_system_prompt");

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "responses",
          headers: {},
          body: {
            store: false,
            instructions: TITLE_SYSTEM_PROMPT,
            input: "Conversation notes",
          },
          client: null,
        }),
      ).toBe("title_system_prompt");

      // Image-only or multimodal user turn must NOT match title_system_prompt.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com/screen.png" },
                  },
                ],
              },
            ],
          },
          client: null,
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Summarize this screenshot" },
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com/screen.png" },
                  },
                ],
              },
            ],
          },
          client: null,
        }),
      ).toBeNull();

      // Later system/developer instruction overriding the title prompt must NOT match.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              { role: "system", content: TITLE_SYSTEM_PROMPT },
              {
                role: "developer",
                content:
                  "Ignore earlier title rules and review this SQL migration.",
              },
              { role: "user", content: "Check the diff" },
            ],
          },
          client: null,
        }),
      ).toBeNull();

      // Multi-turn history must NOT match title_system_prompt.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [
              { role: "user", content: "First" },
              { role: "assistant", content: "Reply" },
              { role: "user", content: "Second" },
            ],
          },
          client: null,
        }),
      ).toBeNull();
    });

    test("matches progress_label_system_prompt only for exact Claude provenance", () => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: PROGRESS_LABEL_SYSTEM_PROMPT,
            messages: [{ role: "user", content: "Edited router.ts" }],
          },
          client: CLAUDE_CLIENT_ID,
        }),
      ).toBe("progress_label_system_prompt");

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "responses",
          headers: {},
          body: {
            store: false,
            instructions: PROGRESS_LABEL_SYSTEM_PROMPT,
            input: [{ role: "user", content: "Edited router.ts" }],
          },
          client: CLAUDE_DESKTOP_CLIENT_ID,
        }),
      ).toBe("progress_label_system_prompt");

      for (const client of [null, "claude-eval-proxy"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: {},
            body: {
              system: PROGRESS_LABEL_SYSTEM_PROMPT,
              messages: [{ role: "user", content: "Edited router.ts" }],
            },
            client,
          }),
        ).toBeNull();
      }
    });

    test("matches complete session-title user envelopes at clean delimiters and rejects ordinary writing tasks", () => {
      for (const prompt of [
        "Please write a 5-10 word title for this conversation.",
        "Please write a 5-10 word title summarizing this conversation:\nUser: fix auth",
        "  You are coming up with a succinct title for an agent chat session based on the initial task description. The user's task description is wrapped in <description> tags below.",
      ]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: {},
            body: {
              messages: [
                { role: "system", content: "Be concise." },
                { role: "user", content: prompt },
              ],
            },
            client: null,
          }),
        ).toBe("title_user_prompt");

        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "responses",
            headers: {},
            body: {
              store: false,
              input: [
                { role: "developer", content: "Be concise." },
                {
                  role: "user",
                  content: [{ type: "input_text", text: prompt }],
                },
              ],
            },
            client: null,
          }),
        ).toBe("title_user_prompt");
      }

      // Ordinary user writing tasks and mid-phrase continuations must NOT match.
      for (const prompt of [
        "Please write a 5-10 word title for our annual report, then draft the executive summary",
        "Please write a 5-10 word title for this conversation starter, then draft ten icebreakers",
      ]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: {},
            body: { messages: [{ role: "user", content: prompt }] },
            client: null,
          }),
        ).toBeNull();
      }

      // Multi-turn conversations must NOT match.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              { role: "user", content: "Hello" },
              { role: "assistant", content: "Hi!" },
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
          },
          client: null,
        }),
      ).toBeNull();
    });

    test("matches claude_side_frame only with exact Claude provenance and valid multipart reminder envelope", () => {
      for (const frame of [
        PROGRESS_LABEL_USER_FRAME,
        PROGRESS_LABEL_AGENT_FRAME,
        AWAY_SUMMARY_FRAME,
      ]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: {},
            body: {
              messages: [
                { role: "user", content: "Fix the bug" },
                { role: "assistant", content: "Working on it." },
                {
                  role: "user",
                  content: [
                    { type: "tool_result", tool_use_id: "t1", content: "ok" },
                    {
                      type: "text",
                      text: "<system-reminder>Context note</system-reminder>",
                    },
                    { type: "text", text: frame },
                  ],
                },
              ],
            },
            client: CLAUDE_CLIENT_ID,
          }),
        ).toBe("claude_side_frame");
      }

      // Arbitrary `claude-*` or non-Claude client must NOT match.
      for (const client of ["codex", "claude-eval-proxy"]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "chat_completions",
            headers: {},
            body: {
              messages: [{ role: "user", content: AWAY_SUMMARY_FRAME }],
            },
            client,
          }),
        ).toBeNull();
      }

      // Preceding reminder with trailing non-reminder text disqualifies side frame.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "<system-reminder>note</system-reminder>Review this",
                  },
                  { type: "text", text: AWAY_SUMMARY_FRAME },
                ],
              },
            ],
          },
          client: CLAUDE_CLIENT_ID,
        }),
      ).toBeNull();

      // Image part in the turn disqualifies side frame.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image_url",
                    image_url: { url: "https://example.com/img.png" },
                  },
                  { type: "text", text: AWAY_SUMMARY_FRAME },
                ],
              },
            ],
          },
          client: CLAUDE_CLIENT_ID,
        }),
      ).toBeNull();
    });
  });

  describe("global vetoes override every positive rule", () => {
    test("vetoes Responses requests unless store === false and free of continuations, stored refs, or encrypted replay items", () => {
      const positiveBase = {
        instructions: TITLE_SYSTEM_PROMPT,
        input: "Please write a 5-10 word title for this conversation.",
      };

      for (const extra of [
        {},
        { store: true },
        { store: false, previous_response_id: "resp_123" },
        { store: false, previous_response_id: "   " },
        { store: false, conversation: "conv_123" },
        { store: false, conversation: { id: "conv_123" } },
        { store: false, background: true },
        { store: false, prompt: { id: "pmpt_123" } },
        {
          store: false,
          input: [
            { type: "item_reference", id: "item_1" },
            {
              role: "user",
              content: "Please write a 5-10 word title for this conversation.",
            },
          ],
        },
        {
          store: false,
          input: [
            {
              type: "reasoning",
              encrypted_content: "enc_blob_abc",
            },
            {
              role: "user",
              content: "Please write a 5-10 word title for this conversation.",
            },
          ],
        },
        {
          store: false,
          input: [
            {
              type: "compaction",
              encrypted_content: "enc_compaction_xyz",
            },
            {
              role: "user",
              content: "Please write a 5-10 word title for this conversation.",
            },
          ],
        },
        {
          store: false,
          input: [
            {
              role: "user",
              content: [
                { type: "input_file", file_id: "file_123" },
                {
                  type: "input_text",
                  text: "Please write a 5-10 word title for this conversation.",
                },
              ],
            },
          ],
        },
      ]) {
        expect(
          classifyAutoRoutingHousekeeping({
            endpoint: "responses",
            headers: { "x-claude-code-request-class": "auxiliary" },
            body: { ...positiveBase, ...extra },
            client: CLAUDE_CODE_CLIENT_ID,
          }),
        ).toBeNull();
      }

      // Stateless Responses with store: false and no refs passes.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "responses",
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: { ...positiveBase, store: false },
          client: CLAUDE_CODE_CLIENT_ID,
        }),
      ).toBe("claude_auxiliary_header");
    });

    test.each([
      ["cachedContent", { cachedContent: "cachedContents/abc" }],
      ["prompt_cache_key", { prompt_cache_key: "key-1" }],
      ["top-level cache_control", { cache_control: { type: "ephemeral" } }],
      [
        "system block cache_control",
        {
          system: [
            {
              type: "text",
              text: TITLE_SYSTEM_PROMPT,
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      [
        "message part prompt_cache_breakpoint",
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Please write a 5-10 word title for this conversation.",
                  prompt_cache_breakpoint: true,
                },
              ],
            },
          ],
        },
      ],
    ])("vetoes provider cache control (%s)", (_label, extra) => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: {
            messages: [
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
            ...extra,
          },
          client: CLAUDE_CODE_CLIENT_ID,
        }),
      ).toBeNull();
    });

    test("vetoes tools before ALL positive rules including headers, while empty tools array is allowed", () => {
      const tool = {
        type: "function",
        function: { name: "read_file", parameters: {} },
      };

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: { [OPENCODE_AGENT_HEADER_KEY]: "title" },
          body: {
            messages: [{ role: "user", content: "Generate title" }],
            tools: [tool],
          },
          client: "opencode",
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: {
            messages: [{ role: "user", content: "Helper task" }],
            tools: [tool],
          },
          client: CLAUDE_CODE_CLIENT_ID,
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: "Title" }],
            tools: [],
          },
          client: null,
        }),
      ).toBe("title_system_prompt");
    });

    test("vetoes OpenCode subagents (x-parent-session-id) even under a custom X-Archestra-Agent-Id", () => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {
            [OPENCODE_AGENT_HEADER_KEY]: "title",
            "x-parent-session-id": "ses-parent-1",
          },
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
          },
          client: "opencode",
        }),
      ).toBeNull();

      // Explicit X-Archestra-Agent-Id cannot mask an OpenCode/Kilo subagent.
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {
            "user-agent": "opencode/1.2.3",
            "x-parent-session-id": "ses-parent-1",
          },
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
          },
          client: "custom-org-agent",
        }),
      ).toBeNull();
    });

    test("vetoes /btw side questions even when paired with x-claude-code-request-class: side_reply", () => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: { "x-claude-code-request-class": "side_reply" },
          body: {
            messages: [
              { role: "user", content: "Work on PR" },
              { role: "assistant", content: "Running checks" },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "<system-reminder>Side context</system-reminder>",
                  },
                  { type: "text", text: SIDE_QUESTION_FRAME },
                ],
              },
            ],
          },
          client: CLAUDE_CODE_CLIENT_ID,
        }),
      ).toBeNull();
    });

    test.each([
      [
        "OpenCode compaction header",
        {
          endpoint: "chat_completions" as const,
          headers: {
            [OPENCODE_AGENT_HEADER_KEY]: "compaction",
            "x-claude-code-request-class": "auxiliary",
          },
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: "Summarize" }],
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "x-openai-subagent compact header",
        {
          endpoint: "responses" as const,
          headers: {
            "x-openai-subagent": "compact",
            "x-claude-code-request-class": "auxiliary",
          },
          body: {
            store: false,
            instructions: TITLE_SYSTEM_PROMPT,
            input: "Summarize",
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "Grok turn-summary compaction header",
        {
          endpoint: "chat_completions" as const,
          headers: {
            "x-grok-client-identifier": "grok-shell",
            "x-grok-conv-id": "turn-summary-abc",
            "x-claude-code-request-class": "auxiliary",
          },
          body: {
            system: TITLE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: "Summarize" }],
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "Codex x-codex-turn-metadata header compaction",
        {
          endpoint: "responses" as const,
          headers: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "compaction",
            }),
            "x-claude-code-request-class": "auxiliary",
          },
          body: {
            store: false,
            instructions: TITLE_SYSTEM_PROMPT,
            input: "Summarize",
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "Codex metadata compaction",
        {
          endpoint: "chat_completions" as const,
          headers: { [OPENCODE_AGENT_HEADER_KEY]: "title" },
          body: {
            client_metadata: { turn_metadata: { request_kind: "compaction" } },
            messages: [
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
          },
          client: "opencode",
        },
      ],
      [
        "Claude compaction prefix in system",
        {
          endpoint: "chat_completions" as const,
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: {
            system: CLAUDE_COMPACTION,
            messages: [
              {
                role: "user",
                content:
                  "Please write a 5-10 word title for this conversation.",
              },
            ],
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "Claude CRITICAL compaction prefix in instructions",
        {
          endpoint: "responses" as const,
          headers: { "x-claude-code-request-class": "auxiliary" },
          body: {
            store: false,
            instructions: CLAUDE_CRITICAL_COMPACTION,
            input: "Please write a 5-10 word title for this conversation.",
          },
          client: CLAUDE_CODE_CLIENT_ID,
        },
      ],
      [
        "Kimi Code compaction prefix in last user message",
        {
          endpoint: "responses" as const,
          headers: { [OPENCODE_AGENT_HEADER_KEY]: "title" },
          body: {
            store: false,
            instructions: TITLE_SYSTEM_PROMPT,
            input: [
              { role: "user", content: "Initial task" },
              {
                role: "user",
                content: [{ type: "input_text", text: KIMI_COMPACTION }],
              },
            ],
          },
          client: "opencode",
        },
      ],
    ])("vetoes compaction (%s)", (_label, params) => {
      expect(classifyAutoRoutingHousekeeping(params)).toBeNull();
    });
  });

  describe("anti-quote guards and short non-matches", () => {
    test("does not match quoted markers in user, system, or side-frame messages", () => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              {
                role: "user",
                content:
                  'Explain why this prompt works: "Please write a 5-10 word title for this conversation"',
              },
            ],
          },
          client: null,
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            system: `Do not behave like: ${TITLE_SYSTEM_PROMPT}`,
            messages: [{ role: "user", content: "Refactor router.ts" }],
          },
          client: null,
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: {
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Here is a prompt from the codebase:" },
                  { type: "text", text: AWAY_SUMMARY_FRAME },
                ],
              },
            ],
          },
          client: CLAUDE_CLIENT_ID,
        }),
      ).toBeNull();
    });

    test.each([
      "count",
      "quota",
      "hello",
      "refactor",
      "ok",
    ])("does not match short or single-word prompt %j", (prompt) => {
      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "chat_completions",
          headers: {},
          body: { messages: [{ role: "user", content: prompt }] },
          client: null,
        }),
      ).toBeNull();

      expect(
        classifyAutoRoutingHousekeeping({
          endpoint: "responses",
          headers: {},
          body: { store: false, input: prompt },
          client: null,
        }),
      ).toBeNull();
    });
  });
});
