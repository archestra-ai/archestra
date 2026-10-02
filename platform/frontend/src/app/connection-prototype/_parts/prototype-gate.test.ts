import { describe, expect, it } from "vitest";
import { isConnectPrototypePlaygroundEnabled } from "./prototype-gate";

describe("isConnectPrototypePlaygroundEnabled", () => {
  it("is on outside production builds", () => {
    expect(
      isConnectPrototypePlaygroundEnabled({ NODE_ENV: "development" }),
    ).toBe(true);
  });

  it("is off in production builds by default", () => {
    expect(
      isConnectPrototypePlaygroundEnabled({ NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("can be opted into by a production deployment", () => {
    expect(
      isConnectPrototypePlaygroundEnabled({
        NODE_ENV: "production",
        ARCHESTRA_FRONTEND_CONNECT_PROTOTYPES_ENABLED: "true",
      }),
    ).toBe(true);
  });
});
