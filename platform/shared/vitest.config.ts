import { defineConfig } from "vitest/config";
import {
  detectResourceEnvelope,
  sharedVitestWorkers,
} from "../vitest.resources";
import { vitestLogPolicy } from "../vitest.shared";

const maxWorkers = sharedVitestWorkers(detectResourceEnvelope());

// Keep default discovery and environment, with the pod's actual worker budget.
export default defineConfig({
  test: {
    ...vitestLogPolicy,
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
  },
});
