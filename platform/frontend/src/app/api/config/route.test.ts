import { getProxyUrl, PROXY_URL_ENV_VAR_NAME } from "./config";

describe("getProxyUrl", () => {
  const originalEnv = process.env[PROXY_URL_ENV_VAR_NAME];

  beforeEach(() => {
    // Reset env var before each test
    delete process.env[PROXY_URL_ENV_VAR_NAME];
  });

  afterEach(() => {
    // Restore original env var after tests
    if (originalEnv) {
      process.env[PROXY_URL_ENV_VAR_NAME] = originalEnv;
    } else {
      delete process.env[PROXY_URL_ENV_VAR_NAME];
    }
  });

  it("should return default localhost URL when env var is not set", () => {
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:9000/v1");
  });

  it("should return env var URL as-is when it already ends with /v1", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "https://api.example.com/v1";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should remove trailing slash and append /v1 when env var ends with /", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "https://api.example.com/";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should append /v1 when env var has no trailing slash or /v1", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "https://api.example.com";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should handle URLs with paths correctly", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "https://api.example.com/proxy";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle URLs with paths ending in slash correctly", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "https://api.example.com/proxy/";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle localhost URLs with ports", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "http://localhost:8080";
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:8080/v1");
  });

  it("should handle empty string env var as if not set", () => {
    process.env[PROXY_URL_ENV_VAR_NAME] = "";
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:9000/v1");
  });
});
