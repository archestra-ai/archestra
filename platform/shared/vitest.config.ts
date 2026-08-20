import { defineConfig } from "vitest/config";
import { vitestLogPolicy } from "../vitest.shared";

// Default discovery and environment are fine for this workspace; the config
// exists to apply the shared log policy (see ../vitest.shared.ts).
export default defineConfig({
  test: {
    ...vitestLogPolicy,
  },
});
