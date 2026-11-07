import { describe, expect, test } from "vitest";
import {
  isAnalyticsEnabled,
  resolveErrorReporting,
  scrubErrorReportBreadcrumb,
  scrubErrorReportEvent,
} from "./error-reporting";

const DEFAULT_DSN = "https://public@errors.example.com/1";

describe("isAnalyticsEnabled", () => {
  test.each([
    [undefined, "production", true],
    ["", "production", true],
    [undefined, "development", false],
    [undefined, "test", false],
    ["disabled", "production", false],
    [" disabled ", "production", false],
    ["enabled", "development", true],
  ])("ARCHESTRA_ANALYTICS=%s with NODE_ENV=%s is %s", (analytics, nodeEnv, expected) => {
    expect(isAnalyticsEnabled({ analytics, nodeEnv })).toBe(expected);
  });
});

describe("resolveErrorReporting", () => {
  test("reports errors only to Archestra's project from a production deployment by default", () => {
    expect(
      resolveErrorReporting({
        dsnOverride: undefined,
        defaultDsn: DEFAULT_DSN,
        environmentOverride: undefined,
        nodeEnv: "production",
        analyticsEnabled: true,
      }),
    ).toEqual({
      enabled: true,
      dsn: DEFAULT_DSN,
      environment: "self-hosted",
      errorsOnly: true,
    });
  });

  test("the analytics opt-out turns default reporting off", () => {
    expect(
      resolveErrorReporting({
        dsnOverride: "",
        defaultDsn: DEFAULT_DSN,
        environmentOverride: undefined,
        nodeEnv: "production",
        analyticsEnabled: false,
      }).enabled,
    ).toBe(false);
  });

  test("an explicit DSN reports with full diagnostics, even with analytics off", () => {
    expect(
      resolveErrorReporting({
        dsnOverride: " https://own@sentry.example.com/2 ",
        defaultDsn: DEFAULT_DSN,
        environmentOverride: undefined,
        nodeEnv: "production",
        analyticsEnabled: false,
      }),
    ).toEqual({
      enabled: true,
      dsn: "https://own@sentry.example.com/2",
      environment: "production",
      errorsOnly: false,
    });
  });

  test("the environment override wins, and development keeps its own tag", () => {
    const base = {
      dsnOverride: undefined,
      defaultDsn: DEFAULT_DSN,
      analyticsEnabled: true,
    };
    expect(
      resolveErrorReporting({
        ...base,
        environmentOverride: "Archestra.dev",
        nodeEnv: "production",
      }).environment,
    ).toBe("archestra.dev");
    expect(
      resolveErrorReporting({
        ...base,
        environmentOverride: undefined,
        nodeEnv: "development",
      }).environment,
    ).toBe("development");
  });
});

describe("scrubErrorReportEvent", () => {
  test("drops request content, keeping the method and the path", () => {
    const event = scrubErrorReportEvent({
      request: {
        method: "POST",
        url: "https://app.example.com/api/chat?token=private#fragment",
        headers: {
          Authorization: "Bearer private-token",
          Cookie: "session=private",
          "x-api-key": "private-key",
        },
        cookies: { session: "private" },
        data: { messages: [{ role: "user", content: "private prompt" }] },
        query_string: "token=private",
        env: { REMOTE_ADDR: "203.0.113.5" },
      },
    });

    expect(event.request).toEqual({
      method: "POST",
      url: "https://app.example.com/api/chat",
    });
  });

  test("keeps only an opaque user id", () => {
    expect(
      scrubErrorReportEvent({
        user: {
          id: "user-1",
          email: "person@example.com",
          username: "Person",
          ip_address: "203.0.113.5",
        },
      }).user,
    ).toEqual({ id: "user-1" });
  });

  test("redacts credentials, emails, URL queries and query parameters in exception messages", () => {
    const event = scrubErrorReportEvent({
      exception: {
        values: [
          {
            type: "Error",
            value:
              "request for person@example.com to https://api.example.com/v1/chat?key=abc123 failed: Authorization: Bearer abc.def.ghi with sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV",
            stacktrace: {
              frames: [{ filename: "app.js", vars: { apiKey: "private" } }],
            },
          },
          {
            type: "DrizzleQueryError",
            value:
              'Failed query: select "id" from "users" where "email" = $1\nparams: person@example.com,private-value',
          },
          {
            type: "Error",
            value:
              "connect to postgres://archestra:hunter2@db.internal:5432/app refused",
          },
        ],
      },
    });

    const [first, query, connection] = event.exception.values;
    expect(first.value).toBe(
      "request for [email] to https://api.example.com/v1/chat failed: Authorization: Bearer [Filtered] with [Filtered]",
    );
    expect(first.stacktrace?.frames?.[0]).toEqual({ filename: "app.js" });
    expect(query.value).toBe(
      'Failed query: select "id" from "users" where "email" = $1\nparams: [Filtered]',
    );
    expect(connection.value).toBe(
      "connect to postgres://[Filtered]@db.internal:5432/app refused",
    );
  });

  test("filters content and credential keys in extra data, keeping diagnostics", () => {
    const event = scrubErrorReportEvent({
      extra: {
        errorMessage: "provider overloaded",
        statusCode: 529,
        parsedError: {
          error: { type: "overloaded_error" },
          messages: [{ content: "private prompt" }],
        },
        toolCall: { name: "search", arguments: { q: "private" } },
        accessToken: "private",
        long: "x".repeat(5000),
      },
    });

    expect(event.extra).toMatchObject({
      errorMessage: "provider overloaded",
      statusCode: 529,
      parsedError: {
        error: { type: "overloaded_error" },
        messages: "[Filtered]",
      },
      toolCall: { name: "search", arguments: "[Filtered]" },
      accessToken: "[Filtered]",
    });
    expect((event.extra.long as string).length).toBeLessThanOrEqual(2001);
  });

  test("redacts text in tag values without dropping the tag", () => {
    expect(
      scrubErrorReportEvent({
        tags: {
          error_type: "secrets_backend_unavailable",
          secrets_backend_error: "permission denied for token=s.private",
        },
      }).tags,
    ).toEqual({
      error_type: "secrets_backend_unavailable",
      secrets_backend_error: "permission denied for token=[Filtered]",
    });
  });
});

describe("scrubErrorReportBreadcrumb", () => {
  test("keeps what a request breadcrumb did, without its query or payload", () => {
    expect(
      scrubErrorReportBreadcrumb({
        type: "http",
        category: "fetch",
        level: "info",
        timestamp: 1,
        data: {
          method: "POST",
          status_code: 500,
          url: "https://api.example.com/v1/tools?secret=private",
          request_body: "private",
        },
      }),
    ).toEqual({
      type: "http",
      category: "fetch",
      level: "info",
      timestamp: 1,
      data: {
        method: "POST",
        status_code: 500,
        url: "https://api.example.com/v1/tools",
      },
    });
  });

  test("drops console and UI messages", () => {
    expect(
      scrubErrorReportBreadcrumb({
        category: "console",
        level: "log",
        message: "user pasted: private prompt",
        data: { arguments: ["private prompt"] },
      }),
    ).toEqual({ category: "console", level: "log" });
  });
});
