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
    repo: "anthropics/claude-code",
    description: "Claude Code agent skills from Anthropic.",
    stars: 125_000,
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
    repo: "nextlevelbuilder/ui-ux-pro-max-skill",
    description: "Advanced UI/UX design patterns.",
    stars: 81_000,
  },
  {
    repo: "anthropics/claude-cookbooks",
    description: "Recipes and patterns for Claude.",
    stars: 43_000,
  },
  {
    repo: "vercel-labs/agent-browser",
    description: "Browser automation capabilities for agents.",
    stars: 34_000,
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
    repo: "openai/openai-agents-python",
    description: "OpenAI agents framework for Python.",
    stars: 27_000,
  },
  {
    repo: "davila7/claude-code-templates",
    description: "Claude Code skill and command templates.",
    stars: 27_000,
  },
  {
    repo: "anthropics/financial-services",
    description: "Financial-services agent patterns from Anthropic.",
    stars: 26_000,
  },
  {
    repo: "googleworkspace/cli",
    description: "Google Workspace integrations.",
    stars: 26_000,
  },
  {
    repo: "langchain-ai/deepagents",
    description: "Deep agent architectures with LangChain.",
    stars: 23_000,
  },
  {
    repo: "openai/skills",
    description: "Skills authored by OpenAI.",
    stars: 20_000,
  },
  {
    repo: "vercel-labs/skills",
    description: "General-purpose agent skills from Vercel Labs.",
    stars: 19_000,
  },
  {
    repo: "anthropics/knowledge-work-plugins",
    description: "Knowledge-work plugins from Anthropic.",
    stars: 12_000,
  },
  {
    repo: "larksuite/cli",
    description: "Lark/Feishu workplace integrations.",
    stars: 12_000,
  },
  {
    repo: "google/skills",
    description: "Skills authored by Google.",
    stars: 10_000,
  },
  {
    repo: "google-labs-code/stitch-skills",
    description: "React components and design documentation.",
    stars: 5_600,
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
    repo: "stripe/agent-toolkit",
    description: "Stripe payments agent toolkit.",
    stars: 1_600,
  },
  {
    repo: "google/adk-docs",
    description: "Google Agent Development Kit reference.",
    stars: 1_400,
  },
  {
    repo: "microsoft/azure-skills",
    description: "Azure infrastructure, AI, and deployment.",
    stars: 1_100,
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
    repo: "firebase/agent-skills",
    description: "Firebase auth, hosting, and Genkit development.",
    stars: 293,
  },
  {
    repo: "anthropics/healthcare",
    description: "Healthcare agent patterns from Anthropic.",
    stars: 260,
  },
  {
    repo: "better-auth/skills",
    description: "Authentication best practices with Better Auth.",
    stars: 191,
  },
  {
    repo: "brightdata/skills",
    description: "Web data collection with Bright Data.",
    stars: 129,
  },
  {
    repo: "resend/resend-skills",
    description: "Email design and delivery with Resend.",
    stars: 121,
  },
  {
    repo: "apollographql/skills",
    description: "GraphQL and Apollo best practices.",
    stars: 73,
  },
  {
    repo: "mastra-ai/skills",
    description: "Mastra agent framework skills.",
    stars: 55,
  },
  {
    repo: "clerk/skills",
    description: "Clerk authentication patterns.",
    stars: 43,
  },
  {
    repo: "prisma/skills",
    description: "Prisma ORM best practices.",
    stars: 37,
  },
  {
    repo: "get-convex/agent-skills",
    description: "Convex backend, database, and performance.",
    stars: 29,
  },
  {
    repo: "genkit-ai/skills",
    description: "Firebase Genkit agent skills.",
    stars: 12,
  },
  {
    repo: "neondatabase/postgres-skills",
    description: "Postgres + Neon serverless best practices.",
    stars: 9,
  },
  {
    repo: "mcp-use/skills",
    description: "Building and using MCP servers.",
    stars: 1,
  },
];
