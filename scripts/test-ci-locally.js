#!/usr/bin/env node
/**
 * Test CI/CD checks locally before opening a PR
 * This script runs the same checks that GitHub Actions runs on pull requests
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const platformDir = join(rootDir, "platform");

const args = process.argv.slice(2);
const skipE2E = args.includes("--skip-e2e");
const skipLicense = args.includes("--skip-license");
const skipCodegen = args.includes("--skip-codegen");
const skipDbMigrations = args.includes("--skip-db-migrations");

function exec(command, options = {}) {
  try {
    execSync(command, {
      stdio: "inherit",
      cwd: platformDir,
      ...options,
    });
    return true;
  } catch (error) {
    return false;
  }
}

function execWithOutput(command, options = {}) {
  try {
    const output = execSync(command, {
      encoding: "utf-8",
      cwd: platformDir,
      ...options,
    });
    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      output: error.stdout?.toString() || error.message,
    };
  }
}

function hasUncommittedChanges() {
  const result = execWithOutput("git diff --exit-code && git diff --cached --exit-code");
  return !result.success;
}

function getChangedFiles() {
  const result = execWithOutput("git diff --name-only");
  return result.success ? result.output.trim().split("\n").filter(Boolean) : [];
}

console.log("🚀 Running CI checks locally...\n");

// Check if we're in the right directory
if (!existsSync(platformDir)) {
  console.error("❌ Error: 'platform' directory not found. Please run this script from the repository root.");
  process.exit(1);
}

try {
  // 1. Type checking, linting, formatting, tests, knip
  console.log("📋 Step 1/5: Running type-check, lint, test, and knip...");
  console.log("   (This runs: type-check, test, knip, biome ci)");
  if (!exec("pnpm check:ci")) {
    console.error("❌ check:ci failed");
    process.exit(1);
  }
  console.log("✅ Type checking, linting, and tests passed\n");

  // 2. Codegen validation
  if (!skipCodegen) {
    console.log("📦 Step 2/5: Validating codegen...");
    console.log("   (Running: pnpm codegen && pnpm lint:fix)");

    const hadChangesBefore = hasUncommittedChanges();

    // Run codegen
    process.env.CODEGEN = "true";
    if (!exec("pnpm codegen")) {
      console.error("❌ codegen failed");
      process.exit(1);
    }

    if (!exec("pnpm lint:fix")) {
      console.error("❌ lint:fix failed");
      process.exit(1);
    }

    // Check for changes
    if (hasUncommittedChanges()) {
      console.error("❌ Generated code is not up to date!");
      console.error("   Please run 'pnpm codegen && pnpm lint:fix' and commit the changes.\n");
      console.error("   Changed files:");
      getChangedFiles().forEach((file) => console.error(`   - ${file}`));
      process.exit(1);
    }

    console.log("✅ Codegen is up to date\n");
  } else {
    console.log("⏭️  Step 2/5: Skipping codegen validation (--skip-codegen)\n");
  }

  // 3. Database migration validation
  if (!skipDbMigrations) {
    console.log("🗄️  Step 3/5: Validating database migrations...");
    console.log("   (Running: pnpm db:generate to check for pending migrations)");

    const hadChangesBefore = hasUncommittedChanges();

    // Run db:generate with timeout (15 seconds like CI)
    const result = execWithOutput("timeout 15 pnpm db:generate 2>&1 || echo TIMEOUT", {
      shell: true,
    });

    if (result.output.includes("TIMEOUT")) {
      console.error("❌ db:generate timed out (likely waiting for interactive input)");
      console.error("   This usually means there are pending database migrations.");
      console.error("   Please run 'pnpm db:generate' locally and commit the migration files.");
      process.exit(1);
    }

    // Check for interactive prompts
    if (result.output.includes("❯") || result.output.match(/Is.*table created or renamed/i)) {
      console.error("❌ Interactive prompt detected - pending database migrations need to be committed");
      console.error("   Please run 'pnpm db:generate' locally and commit the migration files.");
      process.exit(1);
    }

    // Check for uncommitted migration files
    if (hasUncommittedChanges()) {
      console.error("❌ Database schema has changed but migrations are missing!");
      console.error("   Please run 'pnpm db:generate' locally and commit the migration files.\n");
      console.error("   Changed files:");
      getChangedFiles().forEach((file) => console.error(`   - ${file}`));
      process.exit(1);
    }

    console.log("✅ No pending database migrations\n");
  } else {
    console.log("⏭️  Step 3/5: Skipping database migration validation (--skip-db-migrations)\n");
  }

  // 4. License compliance check
  if (!skipLicense) {
    console.log("📜 Step 4/5: Running license compliance check...");
    console.log("   (This checks for GPL/AGPL/Unknown licenses)");
    if (!exec("pnpm license-check --ci")) {
      console.error("❌ License compliance check failed");
      console.error("   Run 'pnpm license-check' to see full details.");
      process.exit(1);
    }
    console.log("✅ License compliance check passed\n");
  } else {
    console.log("⏭️  Step 4/5: Skipping license compliance check (--skip-license)\n");
  }

  // 5. E2E tests (optional, as they require Docker/Kubernetes)
  if (!skipE2E) {
    console.log("🧪 Step 5/5: E2E tests...");
    console.log("   ⚠️  E2E tests require Docker and Kubernetes setup.");
    console.log("   ⚠️  This is complex to run locally. Consider running in CI or skipping with --skip-e2e\n");
    console.log("⏭️  Skipping E2E tests (use --skip-e2e to suppress this message)\n");
  } else {
    console.log("⏭️  Step 5/5: Skipping E2E tests (--skip-e2e)\n");
  }

  console.log("🎉 All CI checks passed!\n");
  console.log("✅ Your PR should pass CI/CD checks.\n");
  console.log("💡 Additional checks you can run manually:");
  console.log("   - PR Title Linting: Use commitlint to validate PR title format");
  console.log("   - Docker Image Scanning: Build and scan Docker image (requires Docker Hub auth)");
  console.log("   - Helm Chart Linting: Run 'helm lint' in platform/helm/archestra");
} catch (error) {
  console.error(`❌ Error: ${error.message}`);
  process.exit(1);
}
