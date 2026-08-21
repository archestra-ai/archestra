import { vi } from "vitest";
import { userHasPermission } from "@/auth";
import ModelModel from "@/models/model";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Model, User } from "@/types";

vi.mock("@/auth");

describe("PATCH /api/llm-models/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    vi.mocked(userHasPermission).mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });

    const { default: modelRoutes } = await import("./llm-provider-models");
    await app.register(modelRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const makeModel = (modelId: string, ignored = false): Promise<Model> =>
    ModelModel.create({
      externalId: `gemini/${modelId}`,
      provider: "gemini",
      modelId,
      description: modelId,
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
      ignored,
      lastSyncedAt: new Date(),
    });

  const bulkPatch = (payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: "/api/llm-models/bulk", payload });

  test("hides every model in the batch and names them by model id", async () => {
    const first = await makeModel("bulk-flash");
    const second = await makeModel("bulk-pro");
    const untouched = await makeModel("bulk-untouched");

    const response = await bulkPatch({
      ids: [first.id, second.id],
      ignored: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-flash" },
        { id: second.id, name: "bulk-pro" },
      ],
      failed: [],
    });

    expect((await ModelModel.findById(first.id))?.ignored).toBe(true);
    expect((await ModelModel.findById(second.id))?.ignored).toBe(true);
    expect((await ModelModel.findById(untouched.id))?.ignored).toBe(false);
  });

  test("shows hidden models again", async () => {
    const hidden = await makeModel("bulk-hidden", true);

    const response = await bulkPatch({ ids: [hidden.id], ignored: false });

    expect(response.statusCode).toBe(200);
    expect((await ModelModel.findById(hidden.id))?.ignored).toBe(false);
  });

  test("leaves a model already in the requested state alone", async () => {
    const already = await makeModel("bulk-already", true);

    const response = await bulkPatch({ ids: [already.id], ignored: true });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: already.id, name: "bulk-already" },
    ]);
  });

  test("reports an unknown id without failing the batch", async () => {
    const known = await makeModel("bulk-known");
    const missing = crypto.randomUUID();

    const response = await bulkPatch({
      ids: [missing, known.id],
      ignored: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: known.id, name: "bulk-known" },
    ]);
    expect(response.json().failed).toEqual([
      { id: missing, name: null, error: "Model not found" },
    ]);
  });

  test("rejects an empty batch", async () => {
    expect((await bulkPatch({ ids: [], ignored: true })).statusCode).toBe(400);
  });

  test("rejects a batch over the cap", async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect((await bulkPatch({ ids, ignored: true })).statusCode).toBe(400);
  });
});
