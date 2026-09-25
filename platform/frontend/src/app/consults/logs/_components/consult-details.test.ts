import { describe, expect, it } from "vitest";
import type { ExternalConsult } from "@/lib/openappa/external-consults.query";
import { toConsultView } from "./consult-details";

describe("toConsultView", () => {
  it("decodes jev diagnostics into per-label probabilities and decisions", () => {
    const view = toConsultView(
      consult({
        diagnostics: base64(
          JSON.stringify({
            jev_diagnostics: {
              version: 1,
              model: "jev-1",
              attempts: ["ok"],
              labels: {
                delta_audience: {
                  probabilities: { self: 0.05, internal: 0.4, public: 0.55 },
                  decision: "public",
                },
                delta_trust: {
                  probabilities: { suspicious: "junk", trusted: 0.9 },
                  decision: "trusted",
                },
                requires_trusted: {
                  probability: 0.2,
                  threshold: 0.5,
                  decision: false,
                },
              },
              elapsed_ms: 812,
            },
          }),
        ),
      }),
    );

    expect(view.diagnostics).toMatchObject({
      kind: "jev",
      jev: {
        labels: {
          delta_audience: {
            probabilities: [
              { option: "self", probability: 0.05 },
              { option: "internal", probability: 0.4 },
              { option: "public", probability: 0.55 },
            ],
          },
          delta_trust: {
            probabilities: [{ option: "trusted", probability: 0.9 }],
          },
          requires_trusted: { probability: 0.2, decision: false },
        },
      },
    });
  });

  it("keeps non-jev diagnostics as JSON or text", () => {
    expect(
      toConsultView(consult({ diagnostics: base64('{"stderr":"boom"}') }))
        .diagnostics,
    ).toEqual({ kind: "json", value: { stderr: "boom" } });
    expect(
      toConsultView(consult({ diagnostics: base64("quota exhausted") }))
        .diagnostics,
    ).toEqual({ kind: "text", text: "quota exhausted" });
  });

  it("extracts the proposed tool call from an annotation request", () => {
    const view = toConsultView(
      consult({
        request: {
          kind: "annotation",
          artifact: {
            args: { name: "fetch", arguments: { url: "https://a.example" } },
          },
        },
      }),
    );
    expect(view.toolCall).toEqual({
      name: "fetch",
      arguments: { url: "https://a.example" },
    });
    expect(toConsultView(consult({ request: null })).toolCall).toBeNull();
  });
});

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function consult(overrides: Partial<ExternalConsult>): ExternalConsult {
  return {
    id: "0199",
    organizationId: "org",
    sessionId: null,
    callerId: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    startedAt: "2026-09-25T10:00:00.000Z",
    durationMs: 800,
    role: "annotator",
    externalName: "jev.tool-call",
    backend: "jev",
    request: {},
    outcome: "answered",
    answer: null,
    rawResponse: null,
    httpStatus: 200,
    diagnostics: null,
    diagnosticsTruncated: false,
    root: "root",
    trajectory: "t",
    callId: null,
    offerId: null,
    callDigest: null,
    ...overrides,
  };
}
