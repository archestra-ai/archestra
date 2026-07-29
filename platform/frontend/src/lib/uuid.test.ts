import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUuid } from "./uuid";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// `randomUUID` may live on the instance or on `Crypto.prototype` depending on
// the environment; shadow it with an own property and restore afterwards.
const originalDescriptor = Object.getOwnPropertyDescriptor(
  crypto,
  "randomUUID",
);

function setCryptoRandomUUID(value: (() => string) | undefined) {
  Object.defineProperty(crypto, "randomUUID", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(crypto, "randomUUID", originalDescriptor);
  } else {
    delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
  vi.restoreAllMocks();
});

describe("generateUuid", () => {
  it("uses crypto.randomUUID when available", () => {
    const randomUUID = vi
      .fn<() => string>()
      .mockReturnValue("11111111-2222-4333-8444-555555555555");
    setCryptoRandomUUID(randomUUID);

    expect(generateUuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("falls back to getRandomValues when crypto.randomUUID is unavailable (insecure context)", () => {
    setCryptoRandomUUID(undefined);
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");

    const uuid = generateUuid();

    expect(getRandomValues).toHaveBeenCalledOnce();
    expect(uuid).toMatch(UUID_V4_PATTERN);
  });

  it("fallback sets the version and variant bits regardless of the random bytes", () => {
    setCryptoRandomUUID(undefined);
    const fillWith = (byte: number) =>
      vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
        if (array instanceof Uint8Array) {
          array.fill(byte);
        }
        return array;
      });

    fillWith(0x00);
    expect(generateUuid()).toBe("00000000-0000-4000-8000-000000000000");

    fillWith(0xff);
    expect(generateUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("fallback produces distinct values", () => {
    setCryptoRandomUUID(undefined);

    expect(generateUuid()).not.toBe(generateUuid());
  });
});
