// https://testing-library.com/docs/svelte-testing-library/setup/#vitest
import "@testing-library/jest-dom/vitest";

// Disable Sentry for tests - prevent sending test data to Sentry
process.env.NEXT_PUBLIC_ARCHESTRA_SENTRY_FRONTEND_DSN = "";
