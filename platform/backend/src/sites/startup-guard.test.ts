import { afterEach } from "vitest";
import { getAppVersion } from "@/app-version";
import config from "@/config";
import { SiteModel } from "@/models";
import { describe, expect, test } from "@/test";
import { assertSiteCanStart } from "./startup-guard";

const registerPrimary = (version: string) =>
  SiteModel.upsert({
    name: "azure-us",
    role: "primary",
    internalUrl: null,
    version,
    capabilities: { keylessProviders: [] },
  });

describe("assertSiteCanStart", () => {
  afterEach(() => {
    config.site.role = "primary";
    config.site.allowVersionSkew = false;
  });

  test("a primary always starts", async () => {
    await registerPrimary("0.0.1-other");
    await expect(assertSiteCanStart()).resolves.toBeUndefined();
  });

  test("a secondary starts on the primary's version", async () => {
    config.site.role = "secondary";
    await registerPrimary(getAppVersion());
    await expect(assertSiteCanStart()).resolves.toBeUndefined();
  });

  test("a secondary refuses another version than the primary's, or no primary", async () => {
    config.site.role = "secondary";
    await expect(assertSiteCanStart()).rejects.toThrow(
      /no primary site is registered/,
    );
    await registerPrimary("0.0.1-other");
    await expect(assertSiteCanStart()).rejects.toThrow(
      `the primary site "azure-us" runs 0.0.1-other and this site runs ${getAppVersion()}`,
    );
    config.site.allowVersionSkew = true;
    await expect(assertSiteCanStart()).resolves.toBeUndefined();
  });
});
