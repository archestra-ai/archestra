# Archestra Platform - Replit Setup

## Project Overview
Archestra is an MCP-native centralized AI platform that simplifies AI usage in organizations. It provides a user-friendly MCP toolbox with observability, control, and strong security foundations.

**Key Features:**
- ChatGPT-like chat interface with MCPs
- Private MCP registry with governance
- Kubernetes-native MCP orchestrator
- Security sub-agents (Dual LLM)
- Non-probabilistic security to prevent data exfiltration
- Cost monitoring, limits and dynamic optimization
- Full observability (metrics, traces, logs)

## Architecture
This is a monorepo using pnpm workspaces and Turbo:
- **Frontend**: Next.js 16 application (port 5000)
- **Backend**: Fastify API server (port 9000)
- **Shared**: Common types and utilities
- **Database**: PostgreSQL (Replit built-in)

## Current State (Dec 4, 2025)
✅ Successfully imported and configured for Replit environment
- Node.js 20 and pnpm 10.24.0 installed
- PostgreSQL database provisioned and schema deployed
- Frontend and backend built and running
- Workflows configured for both services
- Deployment settings configured

## Environment Variables
The project uses Replit's PostgreSQL database via the `DATABASE_URL` secret. Additional configuration is in `platform/.env`:
- `ARCHESTRA_AUTH_SECRET`: Auto-generated secure secret
- `ARCHESTRA_AUTH_ADMIN_EMAIL`: admin@example.com
- `ARCHESTRA_AUTH_ADMIN_PASSWORD`: admin123
- `ARCHESTRA_API_BASE_URL`: http://localhost:9000 (backend)
- `ARCHESTRA_FRONTEND_URL`: http://localhost:5000 (frontend)

**Note**: Kubernetes MCP orchestrator features are disabled as they require a K8s cluster.

## Running the Project

### Development (Current Setup)
Two workflows are configured:
1. **Frontend** - Next.js on port 5000 (webview)
2. **Backend** - Fastify API on port 9000 (console)

Both workflows start automatically and the frontend proxies API requests to the backend.

### Build Commands
```bash
cd platform
pnpm install       # Install dependencies
pnpm build        # Build all packages
pnpm dev          # Run in development mode
pnpm start        # Run in production mode
```

### Database Management
```bash
cd platform
pnpm db:push      # Push schema changes to database
pnpm db:studio    # Open Drizzle Studio (database GUI)
```

## Project Structure
```
platform/
├── backend/          # Fastify API server
│   ├── src/
│   │   ├── routes/   # API endpoints
│   │   ├── models/   # Database models
│   │   ├── database/ # Migrations and schemas
│   │   └── server.ts # Entry point
│   └── package.json
├── frontend/         # Next.js web app
│   ├── app/          # Next.js App Router
│   ├── components/   # React components
│   └── package.json
├── shared/           # Shared types and utilities
├── .env             # Environment configuration
└── package.json     # Root workspace config
```

## Access
- **Frontend UI**: Available via Replit webview (port 5000)
- **Backend API**: http://localhost:9000
- **Default Admin**: admin@example.com / admin123

## Known Limitations in Replit Environment
1. **Kubernetes features disabled**: MCP orchestrator requires a K8s cluster
2. **OpenTelemetry disabled**: No external OTEL collector configured
3. **Sentry disabled**: Error tracking not configured
4. **Analytics disabled**: PostHog analytics not configured

These features can be enabled by adding the appropriate environment variables.

## Next Steps for Users
1. Update admin password in Settings
2. Add OpenAI API key (or other LLM provider keys) in Settings
3. Explore the MCP catalog and install MCP servers
4. Create custom agents and prompts
5. Set up cost limits and optimization rules

## Documentation
- Full documentation: https://archestra.ai/docs
- GitHub: https://github.com/archestra-ai/archestra
- Slack Community: https://join.slack.com/t/archestracommunity/shared_invite/zt-39yk4skox-zBF1NoJ9u4t59OU8XxQChg
