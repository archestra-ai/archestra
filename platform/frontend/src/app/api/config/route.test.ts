import { getProxyUrl } from "./route";

describe("getProxyUrl", () => {
  const originalEnv = process.env.ARCHESTRA_API_BASE_URL;

  beforeEach(() => {
    // Reset env var before each test
    delete process.env.ARCHESTRA_API_BASE_URL;
  });

  afterEach(() => {
    // Restore original env var after tests
    if (originalEnv) {
      process.env.ARCHESTRA_API_BASE_URL = originalEnv;
    } else {
      delete process.env.ARCHESTRA_API_BASE_URL;
    }
  });

  it("should return default localhost URL when env var is not set", () => {
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:9000/v1");
  });

  it("should return env var URL as-is when it already ends with /v1", () => {
    process.env.ARCHESTRA_API_BASE_URL = "https://api.example.com/v1";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should remove trailing slash and append /v1 when env var ends with /", () => {
    process.env.ARCHESTRA_API_BASE_URL = "https://api.example.com/";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should append /v1 when env var has no trailing slash or /v1", () => {
    process.env.ARCHESTRA_API_BASE_URL = "https://api.example.com";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/v1");
  });

  it("should handle URLs with paths correctly", () => {
    process.env.ARCHESTRA_API_BASE_URL = "https://api.example.com/proxy";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle URLs with paths ending in slash correctly", () => {
    process.env.ARCHESTRA_API_BASE_URL = "https://api.example.com/proxy/";
    const result = getProxyUrl();
    expect(result).toBe("https://api.example.com/proxy/v1");
  });

  it("should handle localhost URLs with ports", () => {
    process.env.ARCHESTRA_API_BASE_URL = "http://localhost:8080";
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:8080/v1");
  });

  it("should handle empty string env var as if not set", () => {
    process.env.ARCHESTRA_API_BASE_URL = "";
    const result = getProxyUrl();
    expect(result).toBe("http://localhost:9000/v1");
  });
});
