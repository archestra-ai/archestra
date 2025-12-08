import { defineConfig } from "tsdown";

export default defineConfig({
	// Build all exported modules
	entry: ["index.ts", "access-control.ts", "access-control.ee.ts"],

	clean: true,
	format: ["esm"],

	// Generate source maps for better debugging
	sourcemap: true,

	// Bundle all dependencies into the output
	noExternal: [/.*/],

	tsconfig: "./tsconfig.json",
});
