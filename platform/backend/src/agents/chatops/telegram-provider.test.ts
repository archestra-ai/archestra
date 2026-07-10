import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { ChatOpsChannelBindingModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { ChatOpsEventHandler, IncomingChatMessage } from "@/types";
import { CHATOPS_ATTACHMENT_LIMITS } from "./constants";
import TelegramProvider, { markdownToTelegramHtml } from "./telegram-provider";

vi.mock("@/cache-manager");

const BOT_TOKEN = "123456:test-token";
const BOT_ID = 99;
const BOT_USERNAME = "archestra_bot";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/**
 * Route fetch calls to per-method handlers. Handlers receive the parsed JSON
 * body and return the Telegram response body. `__file` serves file downloads.
 */
function stubTelegramApi(
  handlers: Record<string, (params: Record<string, unknown>) => unknown> & {
    __file?: (path: string) => Uint8Array;
  },
) {
  fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const fileMatch = u.match(/\/file\/bot[^/]+\/(.+)$/);
    if (fileMatch) {
      const file = handlers.__file;
      if (!file) throw new Error(`Unexpected file download: ${fileMatch[1]}`);
      return new Response(Buffer.from(file(fileMatch[1])));
    }
    const method = u.split("/").pop() ?? "";
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected Telegram API call: ${method}`);
    const params = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    return new Response(JSON.stringify(handler(params)));
  });
}

function makeProvider(eventHandler?: ChatOpsEventHandler): TelegramProvider {
  const provider = new TelegramProvider({
    enabled: true,
    botToken: BOT_TOKEN,
  });
  // Set the identity getMe would resolve, without starting the polling loop.
  Object.assign(provider, { botId: BOT_ID, botUsername: BOT_USERNAME });
  if (eventHandler) provider.setEventHandler(eventHandler);
  return provider;
}

function makeEventHandler(): ChatOpsEventHandler {
  return {
    handleIncomingMessage: vi.fn(async () => {}),
    handleInteractiveApprovalDecision: vi.fn(async () => {}),
    handleInteractiveSelection: vi.fn(async () => {}),
    getAccessibleChatopsAgents: vi.fn(async () => []),
  };
}

function dispatchUpdate(
  provider: TelegramProvider,
  update: unknown,
): Promise<void> {
  return (
    provider as unknown as { handleUpdate(update: unknown): Promise<void> }
  ).handleUpdate(update);
}

function telegramUser(id = 555) {
  return { id, is_bot: false, first_name: "Alice", last_name: "Smith" };
}

function dmUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: telegramUser(),
      chat: { id: 555, type: "private" },
      date: 1_700_000_000,
      text: "hello",
      ...overrides,
    },
  };
}

function groupUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 2,
    message: {
      message_id: 20,
      from: telegramUser(),
      chat: { id: -100123, type: "supergroup", title: "Eng" },
      date: 1_700_000_000,
      text: "hello",
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

describe("parseWebhookNotification", () => {
  test("parses a private text message", async () => {
    const provider = makeProvider();
    const message = await provider.parseWebhookNotification(dmUpdate());

    expect(message).toMatchObject({
      messageId: "telegram:555:10",
      channelId: "555",
      workspaceId: null,
      senderId: "555",
      senderName: "Alice Smith",
      text: "hello",
      isThreadReply: false,
      metadata: {
        channelType: "im",
        conversationType: "personal",
        telegramMessageId: 10,
      },
    });
    expect(message?.timestamp).toEqual(new Date(1_700_000_000 * 1000));
  });

  test("ignores messages from bots and channel posts", async () => {
    const provider = makeProvider();
    expect(
      await provider.parseWebhookNotification(
        dmUpdate({ from: { id: 1, is_bot: true, first_name: "Bot" } }),
      ),
    ).toBeNull();
    expect(
      await provider.parseWebhookNotification(
        dmUpdate({ chat: { id: -1, type: "channel" } }),
      ),
    ).toBeNull();
  });

  test("ignores group messages that don't address the bot", async () => {
    const provider = makeProvider();
    expect(await provider.parseWebhookNotification(groupUpdate())).toBeNull();
    // A bare command may target another bot in the group
    expect(
      await provider.parseWebhookNotification(
        groupUpdate({ text: "/weather" }),
      ),
    ).toBeNull();
    expect(
      await provider.parseWebhookNotification(
        groupUpdate({ text: "/weather@some_other_bot" }),
      ),
    ).toBeNull();
  });

  test("processes group commands explicitly addressed to the bot", async () => {
    const provider = makeProvider();
    const message = await provider.parseWebhookNotification(
      groupUpdate({ text: `/weather@${BOT_USERNAME} in Berlin` }),
    );
    expect(message?.text).toBe("/weather in Berlin");
  });

  test("parses a group @mention and strips it from the text", async () => {
    const provider = makeProvider();
    const text = `@${BOT_USERNAME} summarize this`;
    const message = await provider.parseWebhookNotification(
      groupUpdate({
        text,
        entities: [
          { type: "mention", offset: 0, length: BOT_USERNAME.length + 1 },
        ],
      }),
    );

    expect(message).toMatchObject({
      channelId: "-100123",
      text: "summarize this",
      metadata: {
        conversationType: "groupChat",
        botMentioned: true,
        botName: BOT_USERNAME,
      },
    });
  });

  test("treats a reply to the bot as addressed and quotes the parent inline", async () => {
    const provider = makeProvider();
    const message = await provider.parseWebhookNotification(
      groupUpdate({
        text: "yes do that",
        reply_to_message: {
          message_id: 5,
          from: { id: BOT_ID, is_bot: true, first_name: "Bot" },
          chat: { id: -100123, type: "supergroup" },
          date: 1_700_000_000,
          text: "Should I create the ticket?",
        },
      }),
    );

    expect(message?.text).toContain("Should I create the ticket?");
    expect(message?.text).toContain("yes do that");
    expect(message?.metadata?.botMentioned).toBe(true);
  });

  test("uses the forum topic id as thread id", async () => {
    const provider = makeProvider();
    const message = await provider.parseWebhookNotification(
      groupUpdate({
        text: `@${BOT_USERNAME} hi`,
        entities: [
          { type: "mention", offset: 0, length: BOT_USERNAME.length + 1 },
        ],
        message_thread_id: 77,
        is_topic_message: true,
      }),
    );

    expect(message?.threadId).toBe("77");
    expect(message?.metadata?.messageThreadId).toBe(77);
  });

  test("downloads the largest photo that fits the size limit", async () => {
    const provider = makeProvider();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const getFile = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { file_path: "photos/big.jpg" },
    }));
    stubTelegramApi({ getFile, __file: () => bytes });

    const message = await provider.parseWebhookNotification(
      dmUpdate({
        text: undefined,
        caption: "look at this",
        photo: [
          { file_id: "small", file_size: 100 },
          { file_id: "big", file_size: 2000 },
        ],
      }),
    );

    expect(getFile).toHaveBeenCalledWith({ file_id: "big" });
    expect(message?.attachments).toEqual([
      {
        contentType: "image/jpeg",
        contentBase64: Buffer.from(bytes).toString("base64"),
        name: "photo.jpg",
      },
    ]);
  });

  test("skips oversized documents without downloading", async () => {
    const provider = makeProvider();
    stubTelegramApi({}); // any API call would throw

    const message = await provider.parseWebhookNotification(
      dmUpdate({
        text: undefined,
        caption: "report",
        document: {
          file_id: "doc",
          file_name: "big.pdf",
          mime_type: "application/pdf",
          file_size: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE + 1,
        },
      }),
    );

    expect(message?.attachments).toBeUndefined();
    expect(message?.skippedAttachments).toEqual([
      {
        name: "big.pdf",
        sizeBytes: CHATOPS_ATTACHMENT_LIMITS.MAX_ATTACHMENT_SIZE + 1,
        reason: "too_large",
      },
    ]);
  });
});

describe("sendReply", () => {
  const dmMessage: IncomingChatMessage = {
    messageId: "telegram:555:10",
    channelId: "555",
    workspaceId: null,
    senderId: "555",
    senderName: "Alice",
    text: "hi",
    rawText: "hi",
    timestamp: new Date(),
    isThreadReply: false,
    metadata: {
      channelType: "im",
      conversationType: "personal",
      telegramMessageId: 10,
    },
  };

  test("sends HTML with the footer appended and link previews disabled", async () => {
    const provider = makeProvider();
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 42 },
    }));
    stubTelegramApi({ sendMessage });

    const id = await provider.sendReply({
      originalMessage: dmMessage,
      text: "**Done!**",
      footer: "🤖 My Agent",
    });

    expect(id).toBe("42");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const body = sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(body.chat_id).toBe("555");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toBe("<b>Done!</b>\n\n🤖 My Agent");
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    // DMs don't anchor replies
    expect(body.reply_parameters).toBeUndefined();
  });

  test("falls back to plain text when Telegram rejects the markup", async () => {
    const provider = makeProvider();
    const sendMessage = vi
      .fn<(params: Record<string, unknown>) => unknown>()
      .mockReturnValueOnce({
        ok: false,
        error_code: 400,
        description: "can't parse entities",
      })
      .mockReturnValueOnce({ ok: true, result: { message_id: 43 } });
    stubTelegramApi({ sendMessage });

    const id = await provider.sendReply({
      originalMessage: dmMessage,
      text: "broken **markup",
    });

    expect(id).toBe("43");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const retry = sendMessage.mock.calls[1][0] as Record<string, unknown>;
    expect(retry.parse_mode).toBeUndefined();
    expect(retry.text).toBe("broken **markup");
  });

  test("splits long replies into multiple messages and returns the first id", async () => {
    const provider = makeProvider();
    let next = 100;
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: next++ },
    }));
    stubTelegramApi({ sendMessage });

    const id = await provider.sendReply({
      originalMessage: dmMessage,
      text: Array.from({ length: 400 }, (_, i) => `line ${i}`)
        .join("\n")
        .repeat(3),
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(id).toBe("100");
  });

  test("anchors group replies to the triggering message", async () => {
    const provider = makeProvider();
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await provider.sendReply({
      originalMessage: {
        ...dmMessage,
        channelId: "-100123",
        metadata: { conversationType: "groupChat", telegramMessageId: 20 },
      },
      text: "ok",
    });

    const body = sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(body.reply_parameters).toEqual({
      message_id: 20,
      allow_sending_without_reply: true,
    });
  });
});

describe("account linking via /start", () => {
  test("/start with a web-minted code links the chat to the code's email", async ({
    makeOrganization,
  }) => {
    await makeOrganization();
    const code = randomUUID();
    await cacheManager.set(
      `${CacheKey.TelegramLinkCode}-${code}`,
      { email: "alice@example.com" },
      60_000,
    );

    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await dispatchUpdate(provider, dmUpdate({ text: `/start ${code}` }));

    expect(String(sendMessage.mock.calls[0][0].text)).toContain(
      "alice@example.com",
    );
    // Linking is handled by the provider, not forwarded to the agent
    expect(handler.handleIncomingMessage).not.toHaveBeenCalled();
    // The binding now authorizes this Telegram user
    expect(await provider.getUserEmail("555")).toBe("alice@example.com");

    // The code is one-shot: a second /start with it fails (other chat id)
    const secondChat = dmUpdate({
      text: `/start ${code}`,
      chat: { id: 666, type: "private" },
      from: { id: 666, is_bot: false, first_name: "Eve" },
    });
    await dispatchUpdate(provider, secondChat);
    expect(String(sendMessage.mock.calls.at(-1)?.[0].text)).toContain(
      "invalid or expired",
    );
  });

  test("fulfills an existing pending DM binding instead of creating a duplicate", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const pending = await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "telegram",
      channelId: "dm:pending:alice@example.com",
      isDm: true,
      dmOwnerEmail: "alice@example.com",
      channelName: "Direct Message - alice@example.com",
      agentId: null,
    });
    const code = randomUUID();
    await cacheManager.set(
      `${CacheKey.TelegramLinkCode}-${code}`,
      { email: "alice@example.com" },
      60_000,
    );

    const provider = makeProvider(makeEventHandler());
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await dispatchUpdate(provider, dmUpdate({ text: `/start ${code}` }));

    const fulfilled = await ChatOpsChannelBindingModel.findById(pending.id);
    expect(fulfilled?.channelId).toBe("555");
  });

  test("a code carrying only a chat id (bot-minted, for the web) is not redeemable in Telegram", async () => {
    const code = randomUUID();
    await cacheManager.set(
      `${CacheKey.TelegramLinkCode}-${code}`,
      { chatId: "999" },
      60_000,
    );

    const provider = makeProvider(makeEventHandler());
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await dispatchUpdate(provider, dmUpdate({ text: `/start ${code}` }));

    expect(String(sendMessage.mock.calls[0][0].text)).toContain(
      "invalid or expired",
    );
    expect(await provider.getUserEmail("555")).toBeNull();
  });

  test("plain /start replies with a one-shot sign-in link", async () => {
    const provider = makeProvider(makeEventHandler());
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await dispatchUpdate(provider, dmUpdate({ text: "/start" }));

    const reply = String(sendMessage.mock.calls[0][0].text);
    const code = /link-telegram\?code=([0-9a-f-]{36})/.exec(reply)?.[1];
    expect(code).toBeDefined();
    // The code resolves back to the chat that asked for it
    await expect(
      cacheManager.get(`${CacheKey.TelegramLinkCode}-${code}`),
    ).resolves.toEqual({ chatId: "555" });
  });

  test("forwards ordinary messages to the event handler", async () => {
    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const update = dmUpdate();

    await dispatchUpdate(provider, update);

    expect(handler.handleIncomingMessage).toHaveBeenCalledWith(
      provider,
      update,
    );
  });
});

describe("approval flow", () => {
  const originalMessage: IncomingChatMessage = {
    messageId: "telegram:555:10",
    channelId: "555",
    workspaceId: null,
    senderId: "555",
    senderEmail: "alice@example.com",
    senderName: "Alice",
    text: "delete it",
    rawText: "delete it",
    timestamp: new Date(),
    isThreadReply: false,
    metadata: {
      channelType: "im",
      conversationType: "personal",
      telegramMessageId: 10,
    },
  };

  async function postApprovalForm(provider: TelegramProvider) {
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    const answerCallbackQuery = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: true,
    }));
    stubTelegramApi({ sendMessage, answerCallbackQuery });

    await provider.addApprovalRequestForm({
      channelId: "555",
      approvalId: "approval-1",
      taskId: "task-1",
      toolName: "delete_repo",
      toolArgs: { name: "prod" },
      originalMessage,
    });

    const body = sendMessage.mock.calls[0][0] as {
      reply_markup: { inline_keyboard: { callback_data: string }[][] };
    };
    const [approve, decline] = body.reply_markup.inline_keyboard[0];
    return { approve, decline, sendMessage, answerCallbackQuery };
  }

  function approvalClick(fromId: number, data: string) {
    return {
      update_id: 9,
      callback_query: {
        id: "cbq-1",
        from: telegramUser(fromId),
        message: {
          message_id: 33,
          chat: { id: 555, type: "private" },
          date: 1_700_000_000,
        },
        data,
      },
    };
  }

  test("posts approve/decline buttons whose callback_data fits Telegram's 64-byte cap", async () => {
    const provider = makeProvider(makeEventHandler());
    const { approve, decline } = await postApprovalForm(provider);

    expect(approve.callback_data).toMatch(/^apr\|[0-9a-f-]{36}\|a$/);
    expect(decline.callback_data).toMatch(/^apr\|[0-9a-f-]{36}\|d$/);
    expect(Buffer.byteLength(approve.callback_data)).toBeLessThanOrEqual(64);
  });

  test("dispatches the requester's decision and consumes the payload", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "telegram",
      channelId: "555",
      isDm: true,
      dmOwnerEmail: "alice@example.com",
      channelName: "Direct Message - alice@example.com",
      agentId: null,
    });

    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const { approve } = await postApprovalForm(provider);

    await dispatchUpdate(provider, approvalClick(555, approve.callback_data));

    expect(handler.handleInteractiveApprovalDecision).toHaveBeenCalledTimes(1);
    const [, decision] = vi.mocked(handler.handleInteractiveApprovalDecision)
      .mock.calls[0];
    expect(decision).toMatchObject({
      taskId: "task-1",
      approvalId: "approval-1",
      approved: true,
      toolName: "delete_repo",
      messageTs: "33",
      channelId: "555",
      approverEmail: "alice@example.com",
    });
    expect(decision.originalMessage.senderEmail).toBe("alice@example.com");

    // Payload is one-shot: a second click finds nothing to decide
    await dispatchUpdate(provider, approvalClick(555, approve.callback_data));
    expect(handler.handleInteractiveApprovalDecision).toHaveBeenCalledTimes(1);
  });

  test("refuses a decision from anyone but the requester and keeps the payload", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "telegram",
      channelId: "555",
      isDm: true,
      dmOwnerEmail: "alice@example.com",
      channelName: "Direct Message - alice@example.com",
      agentId: null,
    });
    // A different linked user
    await ChatOpsChannelBindingModel.create({
      organizationId: org.id,
      provider: "telegram",
      channelId: "666",
      isDm: true,
      dmOwnerEmail: "mallory@example.com",
      channelName: "Direct Message - mallory@example.com",
      agentId: null,
    });

    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const { approve, answerCallbackQuery } = await postApprovalForm(provider);

    await dispatchUpdate(provider, approvalClick(666, approve.callback_data));
    expect(handler.handleInteractiveApprovalDecision).not.toHaveBeenCalled();
    expect(
      String(answerCallbackQuery.mock.calls.at(-1)?.[0]?.text ?? ""),
    ).toContain("Only the person who asked");

    // The requester can still decide afterwards
    await dispatchUpdate(provider, approvalClick(555, approve.callback_data));
    expect(handler.handleInteractiveApprovalDecision).toHaveBeenCalledTimes(1);
  });

  test("answers an expired approval click without dispatching", async () => {
    const handler = makeEventHandler();
    const provider = makeProvider(handler);
    const answerCallbackQuery = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: true,
    }));
    stubTelegramApi({ answerCallbackQuery });

    await dispatchUpdate(
      provider,
      approvalClick(555, "apr|00000000-0000-4000-8000-000000000000|a"),
    );

    expect(handler.handleInteractiveApprovalDecision).not.toHaveBeenCalled();
    expect(String(answerCallbackQuery.mock.calls[0][0].text)).toContain(
      "expired",
    );
  });
});

describe("agent selection", () => {
  test("sends one button per agent and parses the click back", async () => {
    const provider = makeProvider(makeEventHandler());
    const sendMessage = vi.fn((_params: Record<string, unknown>) => ({
      ok: true,
      result: { message_id: 1 },
    }));
    stubTelegramApi({ sendMessage });

    await provider.sendAgentSelectionCard({
      message: {
        messageId: "telegram:555:10",
        channelId: "555",
        workspaceId: null,
        senderId: "555",
        senderName: "Alice",
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: {},
      },
      agents: [
        { id: "5f1c9c74-0d5f-4a4e-9600-97b0a12345aa", name: "Support" },
        { id: "5f1c9c74-0d5f-4a4e-9600-97b0a12345bb", name: "DevOps" },
      ],
      isWelcome: true,
    });

    const body = sendMessage.mock.calls[0][0] as {
      reply_markup: {
        inline_keyboard: { text: string; callback_data: string }[][];
      };
    };
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    const [first] = body.reply_markup.inline_keyboard[0];
    expect(first.text).toBe("Support");

    const selection = provider.parseInteractivePayload({
      id: "cbq-2",
      from: telegramUser(),
      message: {
        message_id: 1,
        chat: { id: 555, type: "private" },
        date: 1_700_000_000,
      },
      data: first.callback_data,
    });
    expect(selection).toMatchObject({
      agentId: "5f1c9c74-0d5f-4a4e-9600-97b0a12345aa",
      channelId: "555",
      workspaceId: null,
      userId: "555",
      isDm: true,
    });
  });
});

describe("markdownToTelegramHtml", () => {
  test("converts the common markdown constructs and escapes HTML", () => {
    expect(markdownToTelegramHtml("**bold** and `a < b`")).toBe(
      "<b>bold</b> and <code>a &lt; b</code>",
    );
    expect(markdownToTelegramHtml("# Title\nfish & chips")).toBe(
      "<b>Title</b>\nfish &amp; chips",
    );
    expect(markdownToTelegramHtml("[docs](https://example.com/a?b=1)")).toBe(
      '<a href="https://example.com/a?b=1">docs</a>',
    );
    expect(markdownToTelegramHtml("```js\nif (a < b) {}\n```")).toBe(
      "<pre>if (a &lt; b) {}</pre>",
    );
  });

  test("leaves plain numbers and unknown markdown untouched", () => {
    expect(markdownToTelegramHtml("I bought 5 apples and 3 pears")).toBe(
      "I bought 5 apples and 3 pears",
    );
    expect(markdownToTelegramHtml("- item one\n- item two")).toBe(
      "- item one\n- item two",
    );
  });
});

describe("initialize and cleanup", () => {
  test("authenticates, clears any leftover webhook, and stops polling on cleanup", async () => {
    const provider = new TelegramProvider({
      enabled: true,
      botToken: BOT_TOKEN,
    });
    const getMe = vi.fn(() => ({
      ok: true,
      result: { id: BOT_ID, is_bot: true, username: BOT_USERNAME },
    }));
    const deleteWebhook = vi.fn(() => ({
      ok: true,
      result: true,
    }));
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/getMe")) return new Response(JSON.stringify(getMe()));
      if (u.endsWith("/deleteWebhook")) {
        return new Response(JSON.stringify(deleteWebhook()));
      }
      if (u.endsWith("/getUpdates")) {
        // Hang until the polling loop is aborted, like a real long poll
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        });
      }
      throw new Error(`Unexpected call: ${u}`);
    });

    await provider.initialize();
    expect(getMe).toHaveBeenCalledTimes(1);
    expect(deleteWebhook).toHaveBeenCalledTimes(1);
    expect(provider.getBotUsername()).toBe(BOT_USERNAME);

    await provider.cleanup();
    expect(provider.getBotUsername()).toBeNull();
  });

  test("is not configured without a token or when disabled", () => {
    expect(
      new TelegramProvider({ enabled: true, botToken: "" }).isConfigured(),
    ).toBe(false);
    expect(
      new TelegramProvider({ enabled: false, botToken: "x" }).isConfigured(),
    ).toBe(false);
  });
});

describe("getUserEmail", () => {
  test("returns null for unlinked users", async () => {
    const provider = makeProvider();
    expect(await provider.getUserEmail("12345")).toBeNull();
  });
});
