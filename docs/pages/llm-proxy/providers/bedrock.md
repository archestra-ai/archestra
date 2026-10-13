---
title: Amazon Bedrock
description: Connect Amazon Bedrock with an API key, AWS access keys, or the IAM identity of your Archestra deployment.
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use every model in your Amazon Bedrock account through Archestra. Connect with a Bedrock API key or AWS access keys. On AWS, Archestra can use its own IAM role, so it stores no key.

## Adding a Provider

1. Go to **Model Providers → Add API Key** and select **Amazon Bedrock**.
2. Choose the authentication method:
   - **API Key**: paste a Bedrock API key.
   - **AWS SigV4**: enter **Access Key ID**, **Secret Access Key**, and an optional **Session Token**.
   - **Service Account**: use the IAM credentials available to the backend. This requires [`ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED).
3. Choose the **Region** where your models are available.
4. Click **Test & Create**.

The key appears in the provider table, and available models appear under **Models**. For a private endpoint, set **Base URL** under **Advanced**. Ensure the selected region matches that endpoint.

Proxy clients use `https://<archestra-host>/v1/bedrock`. The proxy supports Bedrock Converse and InvokeModel requests. Through Model Router, use `bedrock:<model-id>`.

### IAM Authentication Setup (IRSA)

To use IAM authentication on EKS with [IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html):

1. Create an IAM role with `AmazonBedrockFullAccess` or a scoped policy (see below)
2. Create an [OIDC provider](https://docs.aws.amazon.com/eks/latest/userguide/enable-iam-roles-for-service-accounts.html) for your EKS cluster
3. Configure the IAM role's trust policy to allow the Archestra service account:

   ```json
   {
     "Effect": "Allow",
     "Principal": {
       "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/oidc.eks.<REGION>.amazonaws.com/id/<OIDC_ID>"
     },
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {
       "StringEquals": {
         "oidc.eks.<REGION>.amazonaws.com/id/<OIDC_ID>:sub": "system:serviceaccount:archestra:archestra-platform"
       }
     }
   }
   ```

4. Annotate the Archestra service account:

   ```bash
   kubectl annotate sa archestra-platform -n archestra \
     eks.amazonaws.com/role-arn=arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME>
   ```

5. Set [`ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED) and restart the deployment. Create the provider key using **Service Account**.

### Minimum IAM Policy

Archestra calls the Bedrock **Converse API**, and the **InvokeModel API** for clients that use it (Claude Code, for example). Converse uses the same inference permissions as InvokeModel; see the [AWS Converse API reference](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html). The IAM role needs these actions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*:<ACCOUNT_ID>:inference-profile/us.anthropic.*",
        "arn:aws:bedrock:*::foundation-model/anthropic.*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:ListInferenceProfiles",
        "bedrock:ListFoundationModels"
      ],
      "Resource": "*"
    }
  ]
}
```

Use `*` for the region in resource ARNs — cross-region inference profiles (`us.` prefix) can route requests to any US region.

The two list actions populate the model picker. `ListInferenceProfiles` returns cross-region and application inference profiles. `ListFoundationModels` adds on-demand models that have no inference profile. Without it, those models are not offered.

## Model Discovery

Set [`ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS`](/docs/reference/configuration#ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS) to a comma-separated list such as `anthropic,amazon` to limit discovered model vendors. [`ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS`](/docs/reference/configuration#ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS) limits inference-region prefixes such as `us,global`. Empty values allow all.
