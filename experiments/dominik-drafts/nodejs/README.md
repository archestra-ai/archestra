To run proxy:
1. set OPENAI_KEY in .env in this folder
2. pnpm install
3. pnpm proxy:dev
4. change baseUrl for openai in desktop_app/src/backend/server/plugins/llm/index.ts
5. run desktop_app, choose openai model and chat, see logs in proxy process
