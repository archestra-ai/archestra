import { convertToModelMessages, type UIMessage } from "ai";
import { expect, test } from "vitest";

// regression guard for vercel/ai#10660. we used to vendor patches/ai@6.0.90.patch
// to stop the SDK dropping providerMetadata from file parts; the upstream fix
// (ai >= 6.0.114) made that patch redundant and it was removed. these tests pin
// the behavior the patch guaranteed so a future SDK regression fails loudly here
// instead of silently breaking Gemini multi-turn image generation (missing
// thought_signature) and Anthropic file prompt caching.
//
// scope: this pins the convertToModelMessages rename (providerMetadata ->
// providerOptions), the request-side leg the patch fixed. the patch also touched
// three streaming paths that keep the key as `providerMetadata` on the UI part;
// those are covered by the chat streaming integration tests, not here.

test("assistant file part keeps providerMetadata as providerOptions (Gemini thoughtSignature)", async () => {
  const messages: Omit<UIMessage, "id">[] = [
    {
      role: "assistant",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo=",
          providerMetadata: { google: { thoughtSignature: "sig-abc123" } },
        },
      ],
    },
  ];

  const [assistant] = await convertToModelMessages(messages);
  const filePart = expectFilePart(assistant.content);

  expect(filePart.providerOptions).toEqual({
    google: { thoughtSignature: "sig-abc123" },
  });
});

test("user file part keeps providerMetadata as providerOptions (Anthropic cacheControl)", async () => {
  const messages: Omit<UIMessage, "id">[] = [
    {
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "text/plain",
          url: "data:text/plain;base64,aGk=",
          providerMetadata: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    },
  ];

  const [user] = await convertToModelMessages(messages);
  const filePart = expectFilePart(user.content);

  expect(filePart.providerOptions).toEqual({
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
});

type ModelFilePart = { type: "file"; providerOptions?: unknown };

function expectFilePart(content: unknown): ModelFilePart {
  if (!Array.isArray(content)) {
    throw new Error("Expected model message content to be an array of parts");
  }
  const filePart = content.find(
    (part): part is ModelFilePart =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "file",
  );
  if (!filePart) {
    throw new Error("Expected a file part in the converted model message");
  }
  return filePart;
}
