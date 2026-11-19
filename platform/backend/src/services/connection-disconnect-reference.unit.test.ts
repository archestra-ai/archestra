import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";
import { expect, test } from "vitest";
import {
  disconnectReferenceInBody,
  disconnectReferenceInText,
  issueDisconnectReference,
} from "./connection-disconnect-reference";

const scope = {
  organizationId: "org-1",
  userId: "user-1",
  secret: "a-shared-signing-key-for-disconnect",
};
const now = Date.UTC(2026, 10, 19, 12, 0, 0);

test("a reference is short, safe in a link, and lives as long as a setup window", () => {
  const issued = issueDisconnectReference({ ...scope, now });
  expect(issued.reference).toMatch(/^cdr1_[0-9a-z]+_[A-Za-z0-9_-]{22}$/);
  expect(encodeURIComponent(issued.reference)).toBe(issued.reference);
  expect(issued.expiresAt - now).toBe(CONNECTION_SETUP_WINDOW_MS);
});

test("the person it was issued to presents it anywhere in a prompt", () => {
  const issued = issueDisconnectReference({ ...scope, now });
  const text = `Read https://archestra.example.com/disconnect.md?client=cursor&ref=${issued.reference} and disconnect Cursor.`;
  expect(disconnectReferenceInText({ ...scope, text, now })).toEqual(issued);
  expect(
    disconnectReferenceInText({
      ...scope,
      text,
      now: issued.expiresAt - 1,
    }),
  ).toEqual(issued);
});

test("another person, another organization, and another secret do not own it", () => {
  const { reference } = issueDisconnectReference({ ...scope, now });
  for (const other of [
    { userId: "user-2" },
    { organizationId: "org-2" },
    { secret: "another-signing-key" },
    { secret: undefined },
  ]) {
    expect(
      disconnectReferenceInText({ ...scope, ...other, text: reference, now }),
    ).toBeUndefined();
  }
});

test("an expired reference and a changed one are refused", () => {
  const issued = issueDisconnectReference({ ...scope, now });
  expect(
    disconnectReferenceInText({
      ...scope,
      text: issued.reference,
      now: issued.expiresAt,
    }),
  ).toBeUndefined();
  const [prefix, expiry, mac] = issued.reference.split("_");
  // A later expiry under the same signature, and a signature cut short.
  const later = (Number.parseInt(expiry, 36) + 3600).toString(36);
  for (const forged of [
    `${prefix}_${later}_${mac}`,
    `${prefix}_${expiry}_${mac.slice(0, -1)}`,
    `${issued.reference}x`,
  ]) {
    expect(
      disconnectReferenceInText({ ...scope, text: forged, now }),
    ).toBeUndefined();
  }
});

test("a reference that claims a longer life than one gets is refused", () => {
  // Signed correctly, but for a window nobody is issued.
  const far = issueDisconnectReference({
    ...scope,
    now: now + CONNECTION_SETUP_WINDOW_MS,
  });
  expect(
    disconnectReferenceInText({ ...scope, text: far.reference, now }),
  ).toBeUndefined();
});

test("it is found in any string of a request body, whatever the provider's shape", () => {
  const issued = issueDisconnectReference({ ...scope, now });
  const prompt = `Read /disconnect.md?ref=${issued.reference} and disconnect.`;
  for (const body of [
    { messages: [{ role: "user", content: prompt }] },
    {
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }] },
        { role: "assistant", content: "On it." },
      ],
    },
    { input: [{ type: "message", content: [{ text: prompt }] }] },
  ]) {
    expect(disconnectReferenceInBody({ ...scope, body, now })).toEqual(issued);
  }
  for (const body of [
    null,
    "",
    { messages: [{ role: "user", content: "Disconnect Cursor." }] },
    { messages: [{ role: "user", content: "cdr1_ is how one starts" }] },
  ]) {
    expect(disconnectReferenceInBody({ ...scope, body, now })).toBeUndefined();
  }
});
