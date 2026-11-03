import { describe, expect, test } from "vitest";
import {
  approvalPromptCall,
  formatArgumentLines,
  parseReviewedArguments,
  redactCredentials,
  reviewedToolLabel,
} from "./review-display";

describe("approvalPromptCall", () => {
  test("shows the reviewed call instead of the remedy call", () => {
    expect(
      approvalPromptCall({
        toolName: "archestra__execute_remedy_plan",
        toolArgs: { offer_id: "offer-1" },
        review: {
          text: "Approve this call?",
          tool: "mcp/context7/query-docs",
          arguments: '{"libraryId":"/node"}',
        },
      }),
    ).toEqual({
      toolName: "context7__query-docs",
      toolArgs: { libraryId: "/node" },
    });
  });

  test("falls back to the review text without a structured tool", () => {
    expect(
      approvalPromptCall({
        toolName: "archestra__execute_remedy_plan",
        toolArgs: { offer_id: "offer-1" },
        review: { text: "Approve this call?" },
      }),
    ).toEqual({
      toolName: "archestra__execute_remedy_plan",
      toolArgs: { offer_id: "offer-1" },
      reviewText: "Approve this call?",
    });
  });

  test("keeps a plain tool approval as is", () => {
    expect(
      approvalPromptCall({ toolName: "github__create_issue", toolArgs: {} }),
    ).toEqual({ toolName: "github__create_issue", toolArgs: {} });
  });
});

describe("reviewedToolLabel", () => {
  test("shows a gateway tool the way the agent called it", () => {
    expect(reviewedToolLabel("mcp/context7/query-docs")).toBe(
      "context7__query-docs",
    );
  });

  test("keeps any other name as is", () => {
    expect(reviewedToolLabel("Bash")).toBe("Bash");
    expect(reviewedToolLabel("context7__query-docs")).toBe(
      "context7__query-docs",
    );
    expect(reviewedToolLabel("mcp/a/b/c")).toBe("mcp/a/b/c");
  });
});

describe("parseReviewedArguments", () => {
  test("returns an object", () => {
    expect(parseReviewedArguments('{"libraryId":"/node"}')).toEqual({
      libraryId: "/node",
    });
  });

  test("returns undefined for missing, invalid or non-object JSON", () => {
    expect(parseReviewedArguments(undefined)).toBeUndefined();
    expect(parseReviewedArguments("{")).toBeUndefined();
    expect(parseReviewedArguments("[1]")).toBeUndefined();
    expect(parseReviewedArguments('"text"')).toBeUndefined();
  });
});

describe("formatArgumentLines", () => {
  test("aligns names and wraps long values under the value column", () => {
    expect(
      formatArgumentLines(
        {
          libraryId: "/websites/nodejs",
          query: "fs module file I/O readFile writeFile",
        },
        32,
      ),
    ).toBe(
      [
        "libraryId  /websites/nodejs",
        "query      fs module file I/O",
        "           readFile writeFile",
      ].join("\n"),
    );
  });

  test("serializes non-string values", () => {
    expect(formatArgumentLines({ limit: 5, tags: ["a"] })).toBe(
      'limit  5\ntags   ["a"]',
    );
  });

  test("returns an empty string without arguments", () => {
    expect(formatArgumentLines({})).toBe("");
  });
});

describe("redactCredentials", () => {
  test.each([
    [
      "curl --header 'Authorization: Bearer abc.DEF-123_x' https://x/api",
      "curl --header 'Authorization: Bearer [redacted]' https://x/api",
    ],
    [
      'curl -H "proxy-authorization:Basic dXNlcjpw" -H "X-Api-Key: k1"',
      'curl -H "proxy-authorization:Basic [redacted]" -H "X-Api-Key: [redacted]"',
    ],
    ["Authorization: rawtoken", "Authorization: [redacted]"],
    ["PRIVATE-TOKEN: glpat-1 and more", "PRIVATE-TOKEN: [redacted]"],
    [
      "curl https://x/api/files --output out",
      "curl https://x/api/files --output out",
    ],
    [
      String.raw`curl -H Authorization:\ Bearer\ tok_123 https://x`,
      String.raw`curl -H Authorization:\ Bearer\ [redacted] https://x`,
    ],
    [
      String.raw`curl -H Authorization:Bearer\ tok_123`,
      String.raw`curl -H Authorization:Bearer\ [redacted]`,
    ],
    [
      String.raw`curl -H Authorization:\ tok_123\ -X`,
      String.raw`curl -H Authorization:\ [redacted]`,
    ],
    ["Authorization: tok_123 -X POST", "Authorization: [redacted]"],
    ["Cookie: sid=first; session=tok_secret\nnext", "Cookie: [redacted]\nnext"],
    [
      'curl -H "X-Api-Key: first tok_secret" https://x/?api_key=k&page=2',
      'curl -H "X-Api-Key: [redacted]" https://x/?api_key=[redacted]&page=2',
    ],
    [
      "curl -H Authorization:'Bearer tok_secret' https://x",
      "curl -H Authorization:'Bearer [redacted]' https://x",
    ],
    [
      'curl -H X-Api-Key:"k 1" -b Cookie=sid https://x',
      'curl -H X-Api-Key:"[redacted]" -b Cookie=[redacted] https://x',
    ],
    [
      'Authorization: Digest username="u", response="secret"',
      "Authorization: Digest [redacted]",
    ],
    ['Cookie: sid="secret"\nnext', "Cookie: [redacted]\nnext"],
    ["Cookie: sid='se\\'cret'; theme=dark", "Cookie: [redacted]"],
    ['Authorization: Bearer "tok_secret"', "Authorization: Bearer [redacted]"],
    [
      `curl -H 'Cookie: sid="secret"' -H 'Accept: text/html' https://x`,
      `curl -H 'Cookie: [redacted]' -H 'Accept: text/html' https://x`,
    ],
    [
      String.raw`curl -H "Authorization: Digest username=\"u\", response=\"se\\\"cret\"" -H "Accept: */*"`,
      'curl -H "Authorization: Digest [redacted]" -H "Accept: */*"',
    ],
    [
      "X-Access-Token: t1\nX-Amz-Security-Token: t2\nsession_token: t3",
      "X-Access-Token: [redacted]\nX-Amz-Security-Token: [redacted]\nsession_token: [redacted]",
    ],
    [
      "/token?access_token=t1&refresh_token=t2&id_token=t3&client_secret=t4&aws_secret_access_key=t5&page=2",
      "/token?access_token=[redacted]&refresh_token=[redacted]&id_token=[redacted]&client_secret=[redacted]&aws_secret_access_key=[redacted]&page=2",
    ],
  ])("%s", (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  test("leaves names that only resemble a credential as is", () => {
    const text = "token: t1\naccess: t2\nclient: t3\nsecretary: t4";
    expect(redactCredentials(text)).toBe(text);
  });

  test("redacts a long value in time linear in its length", () => {
    const families = [
      (size: number) => `Authorization:${"\n".repeat(size)}`,
      (size: number) => `Authorization: ${"\\".repeat(size)}`,
      (size: number) => `Cookie: ${'a="'.repeat(size)}`,
      (size: number) => `'Cookie: ${"\\'".repeat(size)}`,
      (size: number) => `${"api_key=a'".repeat(size)} `,
    ];
    // Time per call, the fastest of a few windows that each span many calls.
    const perCall = (text: string) => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let window = 0; window < 3; window++) {
        let calls = 0;
        const started = performance.now();
        do {
          redactCredentials(text);
          calls++;
        } while (performance.now() - started < 10);
        fastest = Math.min(fastest, (performance.now() - started) / calls);
      }
      return fastest;
    };
    for (const input of families) {
      const small = perCall(input(2_000));
      const large = perCall(input(32_000));
      // 16 times the input: linear work grows about 16 times, quadratic 256.
      expect(large).toBeLessThan(small * 64);
    }
  });

  test.each([
    "curl -H 'Authorization: Bearer s3cr3t'\nnext",
    String.raw`curl -H Authorization:\ Bearer\ s3cr3t`,
    String.raw`curl -H Authorization:\ s3cr3t\ next`,
  ])("keeps a JSON payload parseable: %s", (command) => {
    const redacted = redactCredentials(JSON.stringify({ command }));
    expect(parseReviewedArguments(redacted)).toEqual({
      command: redactCredentials(command),
    });
    expect(redacted).not.toContain("s3cr3t");
  });

  test("masks a JSON header map's credential values, nested or encoded in a string", () => {
    const headers = {
      Authorization: "Bearer s3cr3t",
      "X-Api-Key": "s3cr3t",
      Accept: "application/json",
    };
    const masked = {
      Authorization: "Bearer [redacted]",
      "X-Api-Key": "[redacted]",
      Accept: "application/json",
    };
    const redacted = redactCredentials(
      JSON.stringify({
        request: { headers },
        encoded: JSON.stringify({ headers }),
      }),
    );
    const parsed = parseReviewedArguments(redacted);
    expect(parsed).toEqual({
      request: { headers: masked },
      encoded: JSON.stringify({ headers: masked }),
    });
  });

  test("masks the value of a name/value header entry, nested or encoded in a string", () => {
    expect(
      parseReviewedArguments(
        redactCredentials(
          JSON.stringify({
            headers: [{ name: "Authorization", value: "Bearer tok_secret" }],
          }),
        ),
      ),
    ).toEqual({
      headers: [{ name: "Authorization", value: "Bearer [redacted]" }],
    });

    const headers = [
      { key: "x-api-key", value: "s3cr3t" },
      { header: "Cookie", value: "sid=s3cr3t" },
      { name: "Accept", value: "application/json" },
    ];
    const masked = [
      { key: "x-api-key", value: "[redacted]" },
      { header: "Cookie", value: "[redacted]" },
      { name: "Accept", value: "application/json" },
    ];
    expect(
      parseReviewedArguments(
        redactCredentials(
          JSON.stringify({
            requests: [{ headers }, { cookies: { cookie: "sid=s3cr3t" } }],
            encoded: JSON.stringify([{ headers }]),
          }),
        ),
      ),
    ).toEqual({
      requests: [{ headers: masked }, { cookies: { cookie: "[redacted]" } }],
      encoded: JSON.stringify([{ headers: masked }]),
    });
  });

  test("masks the second item of a [name, value] header pair, nested or encoded in a string", () => {
    expect(
      parseReviewedArguments(
        redactCredentials(
          JSON.stringify({ headers: [["Authorization", "Bearer tok_secret"]] }),
        ),
      ),
    ).toEqual({ headers: [["Authorization", "Bearer [redacted]"]] });

    const headers = [
      ["Cookie", "sid=s3cr3t"],
      ["Accept", "application/json"],
    ];
    const masked = [
      ["Cookie", "[redacted]"],
      ["Accept", "application/json"],
    ];
    expect(
      parseReviewedArguments(
        redactCredentials(
          JSON.stringify({
            request: { headers },
            encoded: JSON.stringify([{ headers }]),
          }),
        ),
      ),
    ).toEqual({
      request: { headers: masked },
      encoded: JSON.stringify([{ headers: masked }]),
    });
  });

  test("masks JSON embedded in prose, keeping its indentation and the prose", () => {
    const args = {
      headers: [{ name: "Authorization", value: "Bearer tok_secret" }],
      request: { headers: [["X-Api-Key", "s3cr3t"]], url: "https://x/{id}" },
    };
    const masked = {
      headers: [{ name: "Authorization", value: "Bearer [redacted]" }],
      request: {
        headers: [["X-Api-Key", "[redacted]"]],
        url: "https://x/{id}",
      },
    };
    const prose = (value: object) =>
      `Approve this call? {not json}\nArguments:\n${JSON.stringify(value, null, 2)}\nAuthorization: tok_secret`;
    expect(redactCredentials(prose(args))).toBe(
      prose(masked).replace(
        "Authorization: tok_secret",
        "Authorization: [redacted]",
      ),
    );
  });

  test("stays linear on large text that is not JSON", () => {
    const source = "function f(a) { if (a) { g({ a, b: [1] }); } }\n".repeat(
      5000,
    );
    const inputs = [
      "{".repeat(200_000),
      `${source}{"headers":[["Authorization","Bearer tok_secret"]]}`,
      `curl -H 'Authorization: Bearer tok_secret' -d ${"a".repeat(500_000)}`,
    ];
    const started = performance.now();
    const shown = inputs.map(redactCredentials);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(shown).toEqual([
      inputs[0],
      `${source}{"headers":[["Authorization","Bearer [redacted]"]]}`,
      `curl -H 'Authorization: Bearer [redacted]' -d ${"a".repeat(500_000)}`,
    ]);
  });

  test("keeps every byte of JSON outside the masked strings", () => {
    const json = `Arguments:\n    {\n      "id": 9007199254740993,\n      "note": "caf\\u00e9",\n      "headers": {"X-Api-Key": "tok"}\n    }`;
    expect(redactCredentials(json)).toBe(json.replace('"tok"', '"[redacted]"'));
    expect(
      redactCredentials(
        '{"id":9007199254740993,"headers":{"X-Api-Key":"tok"}}',
      ),
    ).toBe('{"id":9007199254740993,"headers":{"X-Api-Key":"[redacted]"}}');
  });

  const nested = (levels: number, inner: string) =>
    `${"[".repeat(levels)}${inner}${"]".repeat(levels)}`;

  test("shows JSON nested past the depth cap as redacted, without overflowing the stack", () => {
    const json = (key: string, deep: string) =>
      `{"headers":{"X-Api-Key":"${key}"},"deep":${deep}}`;
    expect(
      redactCredentials(
        json("tok", nested(20_000, '"Authorization: Bearer tok"')),
      ),
    ).toBe(json("[redacted]", nested(100, '"[redacted]"')));
  });

  test.each([
    '{"name":"Authorization","value":"sekret"}',
    '["X-Api-Key","sekret"]',
    String.raw`{"X-Api-Key":"sek\"ret"}`,
  ])("shows no credential nested past the depth cap: %s", (inner) => {
    const shown = redactCredentials(nested(150, inner));
    expect(shown).toBe(nested(101, '"[redacted]"'));
    expect(JSON.parse(shown)).toBeInstanceOf(Array);
  });
});
