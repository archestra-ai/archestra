/**
 * How a built-in tool's upload session lives through a retry, against the
 * real shared cache: claimed once, kept for an input round, and carrying the
 * input a caller gave before the upload.
 */

import { describe, expect, test } from "vitest";
import { cacheManager } from "@/cache-manager";
import { BuiltInFileAnswer } from "@/clients/mcp-files/built-in-files";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  answerBuiltInUploadRequest,
  createBuiltInFiles,
  inputResponsesBeforeUpload,
} from "./built-in-files";
import { verifyRequestState } from "./mrtr";
import { type RelayDone, relayDoneKey } from "./upload-store";

setupTestCacheManager();

const CALL = {
  agentId: "agent-1",
  wireName: "archestra__transfer_workspace_file",
  principal: "user:1",
};
const ARGS = { path: "inbox/a.txt", file: { id: "f1" } };
const FILE = { id: "f1", mimeType: "text/plain", size: 3 };
const ANSWERED = { approval: { action: "accept", content: {} } };

/** A first leg that asked for an upload after the caller answered a form. */
async function askedForUpload() {
  const answer = await answerBuiltInUploadRequest({
    answer: {
      kind: "upload",
      input: FILE,
      sink: { kind: "workspace-transfer", ticketId: "ticket-1" },
      expiresAt: Date.now() + 60_000,
    },
    ...CALL,
    args: ARGS,
    inputResponses: ANSWERED,
  });
  const verified = verifyRequestState({
    state: answer.requestState as string,
    principal: CALL.principal,
    method: "tools/call",
    requestParams: { name: CALL.wireName, arguments: ARGS },
  });
  if (!verified.ok || !verified.payload.upload) {
    throw new Error("the upload request carries no upload session");
  }
  const [{ path }] = answer.uploads as { path: string }[];
  const relayId = path.split("/").at(-1) as string;
  return { sessionId: verified.payload.upload, relayId };
}

/** What the relay route records once the caller's bytes are stored. */
async function uploaded(relayId: string) {
  const done: RelayDone = {
    agentId: CALL.agentId,
    principal: CALL.principal,
    method: "PUT",
    size: FILE.size,
    receipt: { path: "inbox/a.txt", size: FILE.size },
  };
  await cacheManager.set(relayDoneKey(relayId), done, 60_000);
}

const take = (files: ReturnType<typeof createBuiltInFiles>) =>
  files.take({ name: "file", value: FILE, descriptor: {} });

describe("a built-in tool's upload session", () => {
  test("keeps the input the caller gave before the upload, for the retry", async () => {
    const { sessionId } = await askedForUpload();
    expect(await inputResponsesBeforeUpload(sessionId)).toEqual(ANSWERED);
  });

  test("is claimed by the retry that reads the file, and only once", async () => {
    const { sessionId, relayId } = await askedForUpload();
    await uploaded(relayId);
    const retry = () =>
      createBuiltInFiles({
        ...CALL,
        declaration: { upload: true },
        uploadSessionId: sessionId,
      });

    const first = retry();
    await expect(first.run(() => take(first))).resolves.toMatchObject({
      kind: "uploaded",
      receipt: { path: "inbox/a.txt" },
    });
    const again = retry();
    const spent = await again.run(() => take(again)).catch((error) => error);
    expect(spent).toBeInstanceOf(BuiltInFileAnswer);
    expect(spent.answer.error.code).toBe(-32602);
  });

  test("is kept for the next retry when the call stops for input after reading the file", async () => {
    const { sessionId, relayId } = await askedForUpload();
    await uploaded(relayId);
    const retry = () =>
      createBuiltInFiles({
        ...CALL,
        declaration: { upload: true },
        uploadSessionId: sessionId,
      });

    const interrupted = retry();
    const inputRound = new Error("needs input");
    await expect(
      interrupted.run(async () => {
        await take(interrupted);
        throw inputRound;
      }),
    ).rejects.toBe(inputRound);

    const next = retry();
    await expect(next.run(() => take(next))).resolves.toMatchObject({
      kind: "uploaded",
    });
  });

  test("is not claimed by a retry before the file arrived", async () => {
    const { sessionId, relayId } = await askedForUpload();
    const retry = () =>
      createBuiltInFiles({
        ...CALL,
        declaration: { upload: true },
        uploadSessionId: sessionId,
      });
    const early = retry();
    await expect(early.run(() => take(early))).resolves.toMatchObject({
      kind: "refused",
    });
    await uploaded(relayId);
    const later = retry();
    await expect(later.run(() => take(later))).resolves.toMatchObject({
      kind: "uploaded",
    });
  });

  test("belongs to the call that asked for the upload", async () => {
    const { sessionId, relayId } = await askedForUpload();
    await uploaded(relayId);
    const other = createBuiltInFiles({
      ...CALL,
      principal: "user:2",
      declaration: { upload: true },
      uploadSessionId: sessionId,
    });
    const refused = await take(other).catch((error) => error);
    expect(refused.answer.error.message).toMatch(/request_mismatch/);
  });
});
