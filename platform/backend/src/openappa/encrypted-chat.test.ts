import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  enterOpenappaEncryptedChat,
  type OpenappaEncryptedChat,
  openappaAnnotatorContext,
  openappaEncryptedChat,
  withOpenappaContentEncryption,
} from "./encrypted-chat";

afterEach(() => enterOpenappaEncryptedChat(null));

test("concurrent annotations keep separate keys and expire each capability when its dispatch settles", async () => {
  const contexts = [context(), context()];
  const releases = contexts.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((release) => {
      resolve = release;
    });
    return { promise, resolve };
  });
  const capabilities: string[] = [];
  const dispatched = contexts.map(async (chat, index) => {
    enterOpenappaEncryptedChat(chat);
    await withOpenappaContentEncryption(
      chat.organizationId,
      chat.audit.conversationId,
      async (encryption) => {
        expect(encryption?.key).toBe(chat.audit.dek);
        expect(encryption?.scope).toBe(
          JSON.stringify([chat.organizationId, chat.audit.conversationId]),
        );
        const capability = encryption?.annotatorContext;
        expect(capability).toBeTruthy();
        if (!capability) throw new Error("Missing annotation capability");
        capabilities[index] = capability;
        expect(openappaAnnotatorContext(capability)).toBe(chat);
        await releases[index].promise;
        expect(openappaAnnotatorContext(capability)).toBe(chat);
      },
    );
  });
  expect(new Set(capabilities).size).toBe(2);
  releases[0].resolve();
  await dispatched[0];
  expect(() => openappaAnnotatorContext(capabilities[0])).toThrow(
    "Expired OpenAPPA annotation context",
  );
  expect(openappaAnnotatorContext(capabilities[1])).toBe(contexts[1]);
  releases[1].resolve();
  await dispatched[1];
  expect(() => openappaAnnotatorContext(capabilities[1])).toThrow(
    "Expired OpenAPPA annotation context",
  );
});

test("a failed dispatch also expires its annotation capability", async () => {
  const chat = context();
  enterOpenappaEncryptedChat(chat);
  let capability: string | undefined;
  await expect(
    withOpenappaContentEncryption(
      chat.organizationId,
      chat.audit.conversationId,
      async (encryption) => {
        capability = encryption?.annotatorContext;
        throw new Error("Dispatch failed");
      },
    ),
  ).rejects.toThrow("Dispatch failed");
  expect(capability).toBeTruthy();
  expect(() => openappaAnnotatorContext(capability)).toThrow(
    "Expired OpenAPPA annotation context",
  );
});

test("keys never cross organization or conversation boundaries, and ordinary calls have no encrypted context", async () => {
  const chat = context();
  enterOpenappaEncryptedChat(chat);
  expect(openappaEncryptedChat(chat.organizationId, randomUUID())).toBeNull();
  expect(
    openappaEncryptedChat(randomUUID(), chat.audit.conversationId),
  ).toBeNull();
  await withOpenappaContentEncryption(
    chat.organizationId,
    randomUUID(),
    async (encryption) => expect(encryption).toBeUndefined(),
  );
  enterOpenappaEncryptedChat(null);
  await withOpenappaContentEncryption(
    chat.organizationId,
    chat.audit.conversationId,
    async (encryption) => expect(encryption).toBeUndefined(),
  );
  expect(openappaAnnotatorContext(undefined)).toBeNull();
  expect(() => openappaAnnotatorContext("unknown")).toThrow(
    "Expired OpenAPPA annotation context",
  );
});

function context(): OpenappaEncryptedChat {
  return {
    organizationId: randomUUID(),
    userId: randomUUID(),
    audit: { conversationId: randomUUID(), dek: randomBytes(32) },
  };
}
