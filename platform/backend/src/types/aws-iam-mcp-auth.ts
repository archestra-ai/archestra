// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.
import { z } from "zod";

/**
 * AWS IAM sign-in for a remote MCP server behind an AWS service that verifies
 * SigV4 (Bedrock AgentCore Gateway or Runtime, API Gateway, Lambda function
 * URLs). Each agent assumes the role with its own JWT-SVID, so the role's
 * trust policy decides which agents may call the server.
 */
export const AwsIamMcpAuthConfigSchema = z.object({
  roleArn: z
    .string()
    .trim()
    .regex(
      /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/,
      "An IAM role ARN, such as arn:aws:iam::123456789012:role/archestra-agents",
    ),
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, "An AWS region, such as us-east-1"),
  /** The SigV4 signing name of the service in front of the MCP server. */
  service: z
    .string()
    .trim()
    .regex(
      /^[a-z0-9-]{1,64}$/,
      "A SigV4 service name, such as bedrock-agentcore",
    ),
  /**
   * The audience of the JWT-SVID, which the IAM OIDC provider lists as a
   * client ID. Defaults to `sts.amazonaws.com`.
   */
  audience: z.string().trim().min(1).max(255).optional(),
});

export type AwsIamMcpAuthConfig = z.infer<typeof AwsIamMcpAuthConfigSchema>;
