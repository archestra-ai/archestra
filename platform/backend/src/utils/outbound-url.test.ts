import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    production: true,
    test: { enableE2eTestEndpoints: false },
  }),
);

const { validateOutboundUrl } = await import("./outbound-url");

describe("validateOutboundUrl in production", () => {
  test("accepts an ordinary https endpoint", () => {
    const result = validateOutboundUrl("https://hooks.example.com/a2a");
    expect(result).toMatchObject({ ok: true });
  });

  test.for([
    ["not a URL at all", "definitely-not-a-url", "not_a_url"],
    ["a bare path", "/hooks/a2a", "not_a_url"],
    // http would put the caller's own credentials on the wire in clear text.
    ["plain http", "http://hooks.example.com/a2a", "scheme_not_https"],
    ["a non-web scheme", "file:///etc/passwd", "scheme_not_https"],
  ])("rejects %s", ([, url, reason]) => {
    expect(validateOutboundUrl(url)).toEqual({ ok: false, reason });
  });

  test.for([
    ["localhost", "https://localhost/hook"],
    ["a localhost subdomain", "https://api.localhost/hook"],
    ["IPv4 loopback", "https://127.0.0.1/hook"],
    ["IPv6 loopback", "https://[::1]/hook"],
    ["an RFC1918 address", "https://10.1.2.3/hook"],
    ["a private 192.168 address", "https://192.168.0.10/hook"],
    ["a 172.16 address", "https://172.16.5.5/hook"],
    // The classic cloud metadata endpoint — the payload SSRF checks exist for.
    ["link-local metadata", "https://169.254.169.254/latest/meta-data"],
  ])("rejects %s as an SSRF target", ([, url]) => {
    expect(validateOutboundUrl(url)).toEqual({
      ok: false,
      reason: "private_or_loopback_host",
    });
  });
});

describe("validateOutboundUrl outside production", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function devValidate(url: string) {
    vi.doMock("@/config", async () =>
      (await import("@/test/mocks/config")).configModuleMock({
        production: false,
        test: { enableE2eTestEndpoints: false },
      }),
    );
    const { validateOutboundUrl: validate } = await import("./outbound-url");
    return validate(url);
  }

  // Local development points webhooks and IdP discovery at localhost, so the
  // scheme requirement and the loopback ban are both relaxed there.
  test.for([
    ["http localhost", "http://localhost:9310/hook"],
    ["http loopback ip", "http://127.0.0.1:9310/hook"],
    ["https localhost", "https://localhost/hook"],
  ])("allows %s for local development", async ([, url]) => {
    expect(await devValidate(url)).toMatchObject({ ok: true });
  });

  test.for([
    // The relaxation stops at loopback: nothing legitimate needs a dev box to
    // reach cloud metadata or a cluster-internal address.
    ["link-local metadata", "http://169.254.169.254/latest/meta-data"],
    ["an RFC1918 address", "http://10.1.2.3/hook"],
    ["a private 192.168 address", "https://192.168.0.10/hook"],
  ])("still rejects %s", async ([, url]) => {
    expect(await devValidate(url)).toEqual({
      ok: false,
      reason: "private_or_loopback_host",
    });
  });
});
