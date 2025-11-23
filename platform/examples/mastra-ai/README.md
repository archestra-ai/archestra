# Mastra GitHub Agent

A basic [Mastra](https://mastra.ai) project featuring a vulnerable GitHub agent. This project containerized by platform/docker-compose-mastra.yml and used for a Mastra + Archestra demo at https://archestra.ai/docs/platform-mastra-example.

1. Install dependencies
```bash
npm install
```

2. Change to project directory and set up environment
```bash
cd mastra-github-agent
cp .env.example .env
# Add your OPENAI_API_KEY and GITHUB_TOKEN to .env file
```

3. Start the app in development mode:
```bash
npm run dev
```
