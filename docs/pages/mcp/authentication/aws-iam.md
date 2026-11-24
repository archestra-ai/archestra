---
title: AWS IAM (SigV4)
description: Let each agent call MCP servers behind AWS as its own IAM role session, with no AWS keys stored
order: 5
lastUpdated: 2026-11-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Call MCP servers that sit behind AWS, such as a Bedrock AgentCore Gateway, as each agent's own IAM role session. Archestra stores no AWS keys: each agent proves who it is with its [SPIFFE ID](/docs/agents/identity/spiffe), assumes the role for an hour, and signs every request with SigV4. The role's trust policy decides which agents may call the server, and CloudTrail names the agent in each session.

Use it for servers behind an AWS service that checks SigV4 signatures: Bedrock AgentCore Gateway or Runtime, API Gateway, or a Lambda function URL. AWS IAM sign-in is an [Enterprise feature](/pricing).

## What Happens on a Tool Call

1. Archestra issues the agent a five-minute JWT with its SPIFFE ID, such as `spiffe://archestra.example.com/agent/<agent ID>`.
2. AWS STS trades it for temporary credentials of the server's role (`AssumeRoleWithWebIdentity`), in a session named `agent-<agent ID>`.
3. Archestra signs each request to the server with those credentials, and reuses them until shortly before they expire.

Listing the server's tools has no agent, so Archestra acts as `spiffe://<trust domain>/platform` for it.

## Trust Archestra in AWS

1. In IAM, go to **Identity providers**, click **Add provider**, and pick **OpenID Connect**.
2. Set **Provider URL** to the issuer shown under **AWS IAM (SigV4)** when you add the server in Archestra, such as `https://archestra.example.com/api/agent-identity/spiffe`, and set **Audience** to `sts.amazonaws.com`.
3. Create a role for **Web identity** with that provider, and give it permission to call the server, such as `bedrock-agentcore:InvokeGateway`.
4. In the role's trust policy, list the SPIFFE IDs that may assume it: each agent that calls the server, and the platform's, so Archestra can list its tools.

```json
{
  "Effect": "Allow",
  "Principal": {
    "Federated": "arn:aws:iam::123456789012:oidc-provider/archestra.example.com/api/agent-identity/spiffe"
  },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": {
      "archestra.example.com/api/agent-identity/spiffe:aud": "sts.amazonaws.com",
      "archestra.example.com/api/agent-identity/spiffe:sub": [
        "spiffe://archestra.example.com/agent/4f6c1b3e-2a5d-4e8f-9b7a-0c1d2e3f4a5b",
        "spiffe://archestra.example.com/platform"
      ]
    }
  }
}
```

An agent's SPIFFE ID is under **Identity** on its **Advanced** step when its identity provider uses SPIFFE IDs, and always follows the pattern above.

## Add the Server

1. [Add a remote MCP server](/docs/mcp/servers/adding) with its URL.
2. Under authentication, pick **AWS IAM (SigV4)**.
3. Set **IAM Role ARN** and **Region**, and set **Service** to the SigV4 name of what the server sits behind, such as `bedrock-agentcore` or `execute-api`.

To check it works, call one of the server's tools from an agent the role trusts. In CloudTrail, the `AssumeRoleWithWebIdentity` event names the session `agent-<agent ID>`.

What to know:

- Only agents call these tools. An App's call is refused, since it has no agent to act as.
- The role grants every agent it trusts the same access. To give agents different access, give each its own role and server.

## Troubleshooting

| What the tool call returns | Fix |
| --- | --- |
| "AWS refused to let this agent assume …" | Add the agent's SPIFFE ID to the role's trust policy, and check the OIDC provider's URL and audience |
| "AWS refused to let the platform assume …" | Add `spiffe://<trust domain>/platform` to the trust policy, so Archestra can list the tools |
| "… so only agents can call its tools" | The call came from an App. Call the tool from an agent. |
| A 403 from the server itself | Give the role permission to call the server, and check **Service** and **Region** |
