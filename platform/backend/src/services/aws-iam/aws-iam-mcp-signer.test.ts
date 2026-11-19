// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { decodeJwt } from "jose";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import { spiffeIssuer } from "@/services/identity-providers/enterprise-managed/spiffe-issuer";
import { useMswServer } from "@/test/msw";
import type { AwsIamMcpAuthConfig } from "@/types/aws-iam-mcp-auth";
import { awsIamMcpSigner } from "./aws-iam-mcp-signer";

const ROLE_ARN = "arn:aws:iam::123456789012:role/archestra-agents";
const SERVER_URL = "https://gateway.example.com/mcp";
const AWS_CONFIG: AwsIamMcpAuthConfig = {
  roleArn: ROLE_ARN,
  region: "us-east-1",
  service: "bedrock-agentcore",
};

let stsRequests: URLSearchParams[];
let stsRefuses: boolean;
let serverRequests: Headers[];

// biome-ignore lint/correctness/useHookAtTopLevel: registers test lifecycle hooks, not a React hook
useMswServer(
  http.post("https://sts.us-east-1.amazonaws.com/", async ({ request }) => {
    stsRequests.push(new URLSearchParams(await request.text()));
    if (stsRefuses) {
      return new HttpResponse(
        `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>Not authorized to perform sts:AssumeRoleWithWebIdentity</Message></Error><RequestId>r1</RequestId></ErrorResponse>`,
        { status: 403, headers: { "content-type": "text/xml" } },
      );
    }
    const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return new HttpResponse(
      `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>ASIATESTSESSION</AccessKeyId><SecretAccessKey>test-secret</SecretAccessKey><SessionToken>test-session-token</SessionToken><Expiration>${expiration}</Expiration></Credentials><AssumedRoleUser><Arn>${ROLE_ARN}/session</Arn><AssumedRoleId>AROATEST:session</AssumedRoleId></AssumedRoleUser></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>r2</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`,
      { headers: { "content-type": "text/xml" } },
    );
  }),
  http.post(SERVER_URL, ({ request }) => {
    serverRequests.push(request.headers);
    return HttpResponse.json({ jsonrpc: "2.0", id: 1, result: {} });
  }),
);

describe("AWS IAM signing for MCP servers", () => {
  beforeEach(() => {
    stsRequests = [];
    stsRefuses = false;
    serverRequests = [];
    awsIamMcpSigner.clearCache();
    spiffeIssuer.clearCache();
  });

  test("signs requests with a role session the agent assumes with its own SPIFFE ID", async () => {
    const agentId = crypto.randomUUID();

    await send({ agentId });

    const [assume] = stsRequests;
    expect(assume.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(assume.get("RoleArn")).toBe(ROLE_ARN);
    expect(assume.get("RoleSessionName")).toBe(`agent-${agentId}`);
    const svid = decodeJwt(assume.get("WebIdentityToken") ?? "");
    expect(svid.sub).toBe(
      `spiffe://${config.agentIdentity.spiffeTrustDomain}/agent/${agentId}`,
    );
    expect(svid.aud).toBe("sts.amazonaws.com");

    const [signed] = serverRequests;
    expect(signed.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIATESTSESSION\/\d{8}\/us-east-1\/bedrock-agentcore\/aws4_request/,
    );
    expect(signed.get("x-amz-security-token")).toBe("test-session-token");
  });

  test("reuses the role session for later requests", async () => {
    const agentId = crypto.randomUUID();

    await send({ agentId });
    await send({ agentId });

    expect(stsRequests).toHaveLength(1);
    expect(serverRequests).toHaveLength(2);
  });

  test("assumes the role as the platform when no agent is calling", async () => {
    await send({ agentId: null });

    const [assume] = stsRequests;
    expect(assume.get("RoleSessionName")).toBe("platform");
    expect(decodeJwt(assume.get("WebIdentityToken") ?? "").sub).toBe(
      `spiffe://${config.agentIdentity.spiffeTrustDomain}/platform`,
    );
  });

  test("explains a refusal from AWS", async () => {
    stsRefuses = true;

    await expect(
      awsIamMcpSigner.assumeRole({
        config: AWS_CONFIG,
        agentId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(
      `AWS refused to let this agent assume ${ROLE_ARN}: Not authorized to perform sts:AssumeRoleWithWebIdentity`,
    );
  });
});

async function send(params: { agentId: string | null }) {
  const response = await awsIamMcpSigner.signingFetch({
    config: AWS_CONFIG,
    agentId: params.agentId,
  })(SERVER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(200);
}
