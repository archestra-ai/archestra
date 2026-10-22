import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import OpenAI from "openai";
import sharp from "sharp";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  InteractionModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, describe, expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import modelRouterRoutes from "./model-router";

setupTestCacheManager();

describe.each([
  false,
  true,
])("common image edits SDK path (agent: %s)", (withAgent) => {
  test("routes exact reference/mask bytes and safe metadata with the same SDK URL/key", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.plugins = [];
    const image = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 4,
        background: { r: 2, g: 3, b: 4, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const calls: Array<{
      path: string;
      apiKey: unknown;
      authorization: unknown;
      fields: Record<string, unknown>;
      files: Buffer[];
    }> = [];
    let cancelled = false;
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const path = request.url?.split("?")[0] ?? "";
      const fields: Record<string, unknown> = {};
      const files: Buffer[] = [];
      if (path.endsWith("/edits")) {
        const form = await new Request("http://fixture.test", {
          method: "POST",
          headers: { "content-type": String(request.headers["content-type"]) },
          body: raw,
        }).formData();
        for (const [name, value] of form) {
          if (typeof value === "string") fields[name] = value;
          else files.push(Buffer.from(await value.arrayBuffer()));
        }
      } else Object.assign(fields, JSON.parse(raw.toString()));
      calls.push({
        path,
        fields,
        files,
        apiKey: request.headers["api-key"],
        authorization: request.headers.authorization,
      });
      if (fields.prompt === "slow") {
        response.once("close", () => {
          cancelled = true;
        });
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          created: 1,
          data: [{ b64_json: image.toString("base64") }],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("No upstream port");
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    const mappings = [];
    for (const provider of ["azure", "openai"] as const) {
      const secret = await makeSecret({
        secret: { apiKey: `synthetic-${provider}-edit-secret` },
      });
      const providerKey = await makeLlmProviderApiKey(
        agent.organizationId,
        secret.id,
        {
          provider,
          baseUrl: `http://127.0.0.1:${address.port}/${provider}/openai/v1`,
        },
      );
      const model = await ModelModel.upsert({
        externalId: `${provider}/gpt-image-1`,
        provider,
        modelId: "gpt-image-1",
        inputModalities: ["image", "text"],
        outputModalities: ["image"],
        lastSyncedAt: new Date(),
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(providerKey.id, [
        model.id,
      ]);
      mappings.push({ provider, providerApiKeyId: providerKey.id });
    }
    const key = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "common edits",
      ...accessGrants("org"),
      providerApiKeys: mappings,
    });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const baseURL = `${origin}/v1/model-router${withAgent ? `/${agent.id}` : ""}`;
    const client = new OpenAI({
      baseURL,
      apiKey: key.value,
      maxRetries: 0,
      timeout: 5000,
    });
    const file = () =>
      new File([image], "reference.png", { type: "image/png" });
    try {
      expect(
        (
          await client.images.generate({
            model: "azure:gpt-image-1",
            prompt: "Draw a circle.",
          })
        ).data?.[0].b64_json,
      ).toBe(image.toString("base64"));
      const result = await client.images.edit({
        model: "azure:gpt-image-1",
        prompt: "Add a blue circle.",
        image: [file(), file()],
        mask: file(),
        n: 1,
        stream: false,
      });
      expect(result.data?.[0].b64_json).toBe(image.toString("base64"));
      const env = {
        ...process.env,
        MEDIA_BASE_URL: baseURL,
        MEDIA_KEY: key.value,
        MEDIA_IMAGE: image.toString("base64"),
      };
      const external: Array<Promise<{ stdout: string }>> = [];
      if (process.env.ARCHESTRA_MEDIA_SDK_JS)
        external.push(
          promisify(execFile)(
            process.execPath,
            ["--input-type=module", "-e", JS_CLIENT],
            { env },
          ),
        );
      if (process.env.ARCHESTRA_MEDIA_SDK_PYTHON)
        external.push(
          promisify(execFile)(
            process.env.ARCHESTRA_MEDIA_SDK_PYTHON,
            ["-c", PY_CLIENT],
            { env },
          ),
        );
      for (const response of await Promise.all(external))
        expect(JSON.parse(response.stdout).success).toBe(true);
      const edits = calls.filter((call) => call.path.endsWith("/edits"));
      expect(edits.length).toBe(1 + external.length);
      for (const edit of edits) {
        expect(edit).toMatchObject({
          path: "/azure/openai/v1/images/edits",
          apiKey: "synthetic-azure-edit-secret",
          fields: {
            model: "gpt-image-1",
            prompt: "Add a blue circle.",
            n: "1",
          },
        });
        expect(edit.files).toHaveLength(3);
        expect(edit.files.every((bytes) => bytes.equals(image))).toBe(true);
        expect(edit.authorization).toBe("Bearer synthetic-azure-edit-secret");
        expect(JSON.stringify(edit)).not.toContain(key.value);
      }
      const before = calls.length;
      await expect(
        client.images.edit({
          model: "openai:gpt-image-1",
          prompt: "Add a blue circle.",
          image: file(),
        }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        client.images.edit({
          model: "azure:unlinked",
          prompt: "Add a blue circle.",
          image: file(),
        }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        client.images.edit({
          model: "azure:gpt-image-1",
          prompt: "Add a blue circle.",
          image: new File([Buffer.from("not an image")], "bad.png", {
            type: "image/png",
          }),
        }),
      ).rejects.toMatchObject({ status: 400 });
      const invalid = new OpenAI({ baseURL, apiKey: "invalid", maxRetries: 0 });
      await expect(
        invalid.images.edit({
          model: "azure:gpt-image-1",
          prompt: "Add a blue circle.",
          image: file(),
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(calls).toHaveLength(before);
      await expect(
        client.images.edit(
          { model: "azure:gpt-image-1", prompt: "slow", image: file() },
          { timeout: 100 },
        ),
      ).rejects.toThrow();
      await vi.waitFor(() => expect(cancelled).toBe(true));
      const rows = (
        await InteractionModel.getAllInteractionsForProfile(agent.id)
      ).filter((row) => row.type === "azure:images");
      expect(
        rows.some(
          (row) =>
            row.inputTokens === 2 &&
            row.outputTokens === 3 &&
            row.cost === null,
        ),
      ).toBe(true);
      expect(
        rows.some(
          (row) =>
            (row.request as { metadata?: { operation: string } }).metadata
              ?.operation === "image-edit",
        ),
      ).toBe(true);
      expect(JSON.stringify(rows.map((row) => row.request))).not.toContain(
        image.toString("base64"),
      );
      expect(JSON.stringify(rows)).not.toContain("synthetic-azure-edit-secret");
    } finally {
      app.server.closeAllConnections();
      await app.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

const JS_CLIENT = `
const {default:OpenAI}=await import(process.env.ARCHESTRA_MEDIA_SDK_JS);
const client=new OpenAI({baseURL:process.env.MEDIA_BASE_URL,apiKey:process.env.MEDIA_KEY,maxRetries:0,timeout:5000});
const image=Buffer.from(process.env.MEDIA_IMAGE,'base64');
const file=()=>new File([image],'reference.png',{type:'image/png'});
const result=await client.images.edit({model:'azure:gpt-image-1',prompt:'Add a blue circle.',image:[file(),file()],mask:file(),n:1,stream:false});
if(result.data[0].b64_json!==process.env.MEDIA_IMAGE)throw Error('Image mismatch');
console.log(JSON.stringify({success:true}));
`;
const PY_CLIENT = `
import os,json,base64,openai
client=openai.OpenAI(base_url=os.environ['MEDIA_BASE_URL'],api_key=os.environ['MEDIA_KEY'],max_retries=0,timeout=5)
image=base64.b64decode(os.environ['MEDIA_IMAGE'])
file=('reference.png',image,'image/png')
result=client.images.edit(model='azure:gpt-image-1',prompt='Add a blue circle.',image=[file,file],mask=file,n=1,stream=False)
assert result.data[0].b64_json==os.environ['MEDIA_IMAGE']
print(json.dumps({'success':True,'sdk':openai.__version__}))
`;
