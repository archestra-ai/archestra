import { readFile } from "node:fs/promises";

const { default: OpenAI, AzureOpenAI, toFile } = await import(
  process.env.MEDIA_SDK_ENTRY ?? "openai"
);
const client = process.env.MEDIA_SDK_AZURE ? new AzureOpenAI({
  endpoint: process.env.MEDIA_SDK_BASE_URL,
  apiKey: process.env.MEDIA_SDK_API_KEY,
  apiVersion: "2025-04-01-preview",
  deployment: "gpt-image-1",
  maxRetries: 0,
  timeout: 10_000,
}) : new OpenAI({
  baseURL: process.env.MEDIA_SDK_BASE_URL,
  apiKey: process.env.MEDIA_SDK_API_KEY,
  maxRetries: 0,
  timeout: 10_000,
});
try {
  const image = await toFile(
    await readFile(process.env.MEDIA_SDK_IMAGE),
    "reference.png",
  );
  let response;
  if (process.env.MEDIA_SDK_OPERATION === "files") {
    const file = await client.files.create({ file: image, purpose: "user_data" });
    const retrieved = await client.files.retrieve(file.id);
    const listed = await client.files.list({ limit: 1 });
    const content = await client.files.content(file.id);
    const bytes = Buffer.from(await content.arrayBuffer());
    const deleted = await client.files.delete(file.id);
    response = { file, retrieved, listed: listed.data, content: bytes.toString("base64"), deleted };
  } else {
    response = await client.images.edit({
        model: "gpt-image-1",
        prompt: "Add a small blue circle.",
        image: [image, image],
        mask: await toFile(await readFile(process.env.MEDIA_SDK_IMAGE), "mask.png"),
        n: 1,
        stream: false,
      });
  }
  process.stdout.write(JSON.stringify({ status: 200, response }));
} catch (error) {
  process.stdout.write(JSON.stringify({ status: error.status ?? null, type: error.name }));
  process.exitCode = 0;
}
