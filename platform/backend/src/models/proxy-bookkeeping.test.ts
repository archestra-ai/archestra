import { vi } from "vitest";
import { expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import { drainBackgroundWork } from "@/utils/background-work";
import ModelModel from "./model";
import VirtualApiKeyModel from "./virtual-api-key";

test("warm virtual-key validation avoids timestamp writes and refreshes after a minute", async ({
  makeOrganization,
  makeUser,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  const { value, virtualKey } = await VirtualApiKeyModel.create({
    organizationId: org.id,
    authorId: user.id,
    name: "bookkeeping key",
    keyType: "passthrough",
  });
  await VirtualApiKeyModel.validateToken(value);
  await drainBackgroundWork();
  const first = await VirtualApiKeyModel.findById(virtualKey.id);
  expect(first?.lastUsedAt).toBeInstanceOf(Date);
  const { result, statements } = await recordQueries(() =>
    VirtualApiKeyModel.validateToken(value),
  );
  expect(result?.virtualKey.id).toBe(virtualKey.id);
  expect(statements.some((s) => /update "virtual_api_keys"/i.test(s))).toBe(
    false,
  );

  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime((first?.lastUsedAt?.getTime() ?? 0) + 60_001);
    await VirtualApiKeyModel.validateToken(value);
    await drainBackgroundWork();
    const refreshed = await VirtualApiKeyModel.findById(virtualKey.id);
    expect(refreshed?.lastUsedAt?.getTime()).toBeGreaterThan(
      first?.lastUsedAt?.getTime() ?? 0,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("known model discovery is a read and a deleted model can be discovered again", async () => {
  const first = await ModelModel.ensureModelExists(
    "bookkeeping-model",
    "openai",
  );
  expect(first).not.toBeNull();
  const { result, statements } = await recordQueries(() =>
    ModelModel.ensureModelExists("bookkeeping-model", "openai"),
  );
  expect(result).toBeNull();
  expect(statements).toHaveLength(1);
  expect(statements[0]).toMatch(/^select /i);
  await ModelModel.delete("openai", "bookkeeping-model");
  const recreated = await ModelModel.ensureModelExists(
    "bookkeeping-model",
    "openai",
  );
  expect(recreated).not.toBeNull();
  expect(recreated?.id).not.toBe(first?.id);
});
