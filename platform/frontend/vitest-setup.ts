// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";

// Disable Sentry during tests (even if DSN is configured in .env)
process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN = "";
