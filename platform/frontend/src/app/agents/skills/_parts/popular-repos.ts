export interface PopularRepo {
  repo: string;
  description: string;
  /** Approximate GitHub star count, used for default ordering. */
  stars: number;
}

// Curated popular agent-skill repositories. Source: https://www.skills.sh/.
// Stars sampled via shields.io; ordered by stars descending.
export const POPULAR_REPOS: PopularRepo[] = [
  {
    repo: "obra/superpowers",
    description: "Agent coordination and development workflow.",
    stars: 200_000,
  },
  {
    repo: "anthropics/skills",
    description: "Document processing and AI capabilities from Anthropic.",
    stars: 138_000,
  },
  {
    repo: "mattpocock/skills",
    description: "Debugging, architecture, and code review.",
    stars: 97_000,
  },
  {
    repo: "browser-use/browser-use",
    description: "Browser automation and interaction capabilities.",
    stars: 95_000,
  },
  {
    repo: "github/awesome-copilot",
    description: "GitHub's curated Copilot skills.",
    stars: 33_000,
  },
  {
    repo: "vercel-labs/agent-skills",
    description: "React, composition patterns, and deployment from Vercel.",
    stars: 27_000,
  },
  {
    repo: "googleworkspace/cli",
    description: "Google Workspace integrations.",
    stars: 26_000,
  },
  {
    repo: "openai/skills",
    description: "Skills authored by OpenAI.",
    stars: 20_000,
  },
  {
    repo: "huggingface/skills",
    description: "Hugging Face models, datasets, and ML workflows.",
    stars: 10_611,
  },
  {
    repo: "google/skills",
    description: "Skills authored by Google.",
    stars: 10_000,
  },
  {
    repo: "trailofbits/skills",
    description:
      "Security auditing and vulnerability research from Trail of Bits.",
    stars: 5_529,
  },
  {
    repo: "antfu/skills",
    description: "Skills from Anthony Fu (Vite/Vue ecosystem).",
    stars: 5_000,
  },
  {
    repo: "google-gemini/gemini-skills",
    description: "Gemini agent skills.",
    stars: 3_500,
  },
  {
    repo: "remotion-dev/skills",
    description: "Programmatic video creation with Remotion.",
    stars: 3_200,
  },
  {
    repo: "microsoft/skills",
    description: "Microsoft development tooling and patterns.",
    stars: 2_451,
  },
  {
    repo: "supabase/agent-skills",
    description: "PostgreSQL and Supabase best practices.",
    stars: 2_100,
  },
  {
    repo: "apify/agent-skills",
    description: "Web scraping and crawling with Apify.",
    stars: 2_100,
  },
  {
    repo: "flutter/skills",
    description: "Flutter mobile development.",
    stars: 2_100,
  },
  {
    repo: "dotnet/skills",
    description: ".NET development skills.",
    stars: 1_900,
  },
  {
    repo: "expo/skills",
    description: "Expo and React Native development.",
    stars: 1_900,
  },
  {
    repo: "ibelick/ui-skills",
    description: "UI component patterns.",
    stars: 1_700,
  },
  {
    repo: "cloudflare/skills",
    description: "Cloudflare Workers, CDN, and edge skills.",
    stars: 1_600,
  },
  {
    repo: "microsoft/azure-skills",
    description: "Azure infrastructure, AI, and deployment.",
    stars: 1_100,
  },
  {
    repo: "NVIDIA/skills",
    description: "NVIDIA GPU computing and AI development.",
    stars: 933,
  },
  {
    repo: "vercel-labs/next-skills",
    description: "Next.js framework best practices.",
    stars: 882,
  },
  {
    repo: "langchain-ai/langchain-skills",
    description: "LangChain agent patterns.",
    stars: 713,
  },
  {
    repo: "hashicorp/agent-skills",
    description: "Terraform, Vault, and HashiCorp infrastructure automation.",
    stars: 646,
  },
  {
    repo: "dbt-labs/dbt-agent-skills",
    description: "Data transformation and modeling with dbt.",
    stars: 540,
  },
  {
    repo: "elastic/agent-skills",
    description: "Search, observability, and security with Elastic.",
    stars: 501,
  },
  {
    repo: "firecrawl/cli",
    description: "Web crawling and data extraction.",
    stars: 413,
  },
  {
    repo: "angular/skills",
    description: "Angular framework best practices.",
    stars: 360,
  },
  {
    repo: "LukasNiessen/kubernetes-skill",
    description: "Kubernetes operations and troubleshooting.",
    stars: 344,
  },
  {
    repo: "firebase/agent-skills",
    description: "Firebase auth, hosting, and Genkit development.",
    stars: 293,
  },
  {
    repo: "semgrep/skills",
    description: "Static analysis and security scanning with Semgrep.",
    stars: 217,
  },
  {
    repo: "better-auth/skills",
    description: "Authentication best practices with Better Auth.",
    stars: 191,
  },
  {
    repo: "fluxcd/agent-skills",
    description: "GitOps continuous delivery for Kubernetes with Flux.",
    stars: 163,
  },
  {
    repo: "databricks/databricks-agent-skills",
    description: "Data engineering and analytics on Databricks.",
    stars: 144,
  },
  {
    repo: "grafana/skills",
    description: "Dashboards, observability, and alerting with Grafana.",
    stars: 140,
  },
  {
    repo: "datadog-labs/agent-skills",
    description: "Monitoring, metrics, and tracing with Datadog.",
    stars: 126,
  },
  {
    repo: "ServiceNow/sdk",
    description: "ServiceNow platform development with the SDK.",
    stars: 74,
  },
  {
    repo: "dash0hq/agent-skills",
    description: "OpenTelemetry-native observability with Dash0.",
    stars: 64,
  },
  {
    repo: "slackapi/slack-mcp-plugin",
    description: "Slack app development and MCP integration.",
    stars: 62,
  },
  {
    repo: "pulumi/agent-skills",
    description: "Infrastructure as code with Pulumi.",
    stars: 54,
  },
  {
    repo: "mlflow/skills",
    description: "Experiment tracking and model lifecycle with MLflow.",
    stars: 48,
  },
  {
    repo: "prisma/skills",
    description: "Prisma ORM best practices.",
    stars: 37,
  },
  {
    repo: "Snowflake-Labs/coco-skills",
    description: "Snowflake data warehouse and analytics.",
    stars: 32,
  },
  {
    repo: "get-convex/agent-skills",
    description: "Convex backend, database, and performance.",
    stars: 29,
  },
  {
    repo: "aws-samples/sample-agent-skills-for-builders",
    description: "AWS developer building blocks and workflows.",
    stars: 12,
  },
  {
    repo: "atlassian/forge-skills",
    description: "Atlassian Forge app development for Jira and Confluence.",
    stars: 11,
  },
  {
    repo: "neondatabase/postgres-skills",
    description: "Postgres + Neon serverless best practices.",
    stars: 9,
  },
  {
    repo: "aws-samples/sample-aws-ops-skills-for-agents",
    description: "AWS cloud operations and management.",
    stars: 5,
  },
];
