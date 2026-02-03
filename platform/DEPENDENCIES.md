# Archestra Platform Dependencies

This document outlines the required libraries, Docker images, and environment setup needed to run the Archestra Platform.

## 🐳 Docker Images

The following services are required to run the full platform stack:

| Service | Image | Purpose |
|---------|-------|---------|
| **Core Database** | `postgres:16-alpine` | Primary PostgreSQL database. |
| **Testing** | `wiremock/wiremock:3.2.0` | API mocking for E2E tests. |
| **Logic/Workflows** | `docker.n8n.io/n8nio/n8n` | Workflow automation engine. |
| **Knowledge Graph** | `neo4j:5-community` | Graph database for LightRAG. |
| **Vector DB** | `qdrant/qdrant:v1.12.0` | Vector storage for embeddings. |
| **RAG Service** | `ghcr.io/hkuds/lightrag:latest` | Retrieval-Augmented Generation service. |
| **Secrets** | `hashicorp/vault:latest` | Secure secret and credential management. |
| **Edge Proxy** | `traefik` | Reverse proxy and load balancer. |
| **Metrics** | `prom/prometheus:latest` | Time-series database for metrics. |
| **Visualization** | `grafana/grafana:latest` | Metrics dashboard. |
| **Tracing** | `grafana/tempo:latest` | Distributed tracing backend. |
| **Observability** | `otel/opentelemetry-collector-contrib:latest` | Telemetry data collector. |

## 📚 Core Libraries

### Backend (Node.js/Fastify)
- **Fastify**: Web framework engine.
- **Drizzle ORM**: TypeScript ORM for database interactions.
- **Better Auth**: Comprehensive authentication and authorization.
- **AI SDK (Vercel)**: Unified interface for LLM providers (OpenAI, Anthropic, Gemini, etc.).
- **OpenRouter SDK**: Direct integration with OpenRouter's API.
- **OpenTelemetry**: Instrumentation for tracing and observability.
- **Zod**: Runtime type safety and schema validation.
- **Vitest**: Backend unit and integration testing.

### Frontend (Next.js/React)
- **Next.js**: Full-stack React framework with Turbopack.
- **Radix UI**: Unstyled, accessible UI primitives.
- **TanStack Query (React Query)**: Asynchronous state management.
- **TailwindCSS**: Utility-first CSS framework.
- **Lucide React**: Modern icon set.
- **Monaco Editor**: Code editor component for MCP configs.
- **Xyflow (React Flow)**: Visualizing agent interactions and graphs.

### E2E Tests
- **Playwright**: End-to-end browser and API testing.

## ⚙️ Getting Started
Activate the conda environment and install all dependencies:
```bash
conda activate archestra
pnpm install
pnpm --filter @e2e-tests exec playwright install chromium
```

## 🚀 Execution Commands

### Local Development
To start both the backend and frontend in development mode:
```bash
conda activate archestra
pnpm dev
```
*Note: Ensure PostgreSQL is running (`docker start archestra-postgres`) before starting.*

### Production Build
To build and start the production-ready application:
```bash
pnpm build
pnpm start
```

### Database Management
- **Generate Migrations**: `pnpm db:generate`
- **Apply Migrations**: `pnpm db:migrate`
- **Seed Mock Data**: `pnpm db:seed:mock-data`

## 🧪 Testing Commands could all be run by `./run_tests_sequentially.sh`

### 1. Run All Unit Tests
Executes unit tests for both backend and frontend:
```bash
pnpm test
```

### 2. Provider-Specific Unit Tests (Backend)
To run tests for a specific adapter (e.g., OpenRouter):
```bash
cd archestra/platform/backend
pnpm vitest openrouter.test.ts --run
```

### 3. End-to-End (E2E) Tests
E2E tests require a running backend and WireMock.

**Full E2E Suite**:
```bash
pnpm test:e2e
```

**OpenRouter Specific E2E Tests**:
```bash
# Start backend with WireMock mapping for OpenRouter
ARCHESTRA_OPENROUTER_BASE_URL=http://localhost:9092/openrouter/api/v1 pnpm dev

# In a new terminal, run the specific E2E test
pnpm test:e2e --grep Openrouter
```

**Playwright UI (Interactive)**:
```bash
pnpm test:e2e:ui
```

## 🧹 Cleanup & Troubleshooting

### Port Cleanup
If the application crashes or ports remain bound, use `fuser` to kill the processes:
```bash
# Kill processes on default ports (Backend: 9000, Frontend: 3000, Metrics: 9050)
fuser -k 9000/tcp 3000/tcp 9050/tcp
```
