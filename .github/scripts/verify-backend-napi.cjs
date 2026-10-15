// Resolve from the consumer workspace, including on runners without Cargo.
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

const requireBackend = createRequire(resolve("backend/package.json"));
for (const name of [
  "@archestra/app-runtime-rs",
  "@archestra/sandbox-rs",
  "@archestra/image-rs",
  "@archestra/openappa-rs",
]) {
  requireBackend(name);
}
