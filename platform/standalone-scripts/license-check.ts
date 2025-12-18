/**
 * Recursively check licenses of all dependencies
 *
 * Usage:
 *   tsx license-check.ts [filter] [package-name]
 *
 * Examples:
 *   tsx license-check.ts              # Show all packages
 *   tsx license-check.ts gpl          # Show only GPL packages
 *   tsx license-check.ts lookup react # Look up specific package
 *   tsx license-check.ts --ci         # CI mode: fail if GPL/AGPL/Unknown found
 *
 * Filters:
 *   (none)  - Show all packages grouped by license type
 *   gpl     - Show only GPL/LGPL/AGPL licensed packages
 *   mit     - Show only MIT licensed packages
 *   apache  - Show only Apache licensed packages
 *   bsd     - Show only BSD licensed packages
 *   isc     - Show only ISC licensed packages
 *   other   - Show unrecognized licenses
 *   lookup  - Look up a specific package (requires package-name argument)
 *   --ci    - CI mode: exit with code 1 if GPL/AGPL/Unknown dependencies found
 *
 * Allowlist:
 *   Packages with Unknown licenses can be manually verified and added to
 *   license-resolution.json. Include:
 *   - license: The verified license type (e.g., "Apache-2.0")
 *   - source: URL to the license file or documentation
 *   - verifiedBy: Who verified it (e.g., "manual inspection")
 *   - verifiedDate: When it was verified (e.g., "2025-12-18")
 */

const fs = require("node:fs");
const path = require("node:path");

// Load manually verified licenses from external JSON file
// Edit license-resolution.json to add/update verified licenses
let VERIFIED_LICENSES = {};
try {
  const resolutionPath = path.join(__dirname, "license-resolution.json");
  const resolutionData = JSON.parse(fs.readFileSync(resolutionPath, "utf-8"));
  VERIFIED_LICENSES = resolutionData.licenses || {};
} catch (_e) {
  console.warn(
    "Warning: Could not load license-resolution.json, using empty verified list",
  );
}

const filterType = process.argv[2]; // 'gpl', 'mit', or undefined for all
const packageName = process.argv[3]; // specific package to look up
const ciMode = filterType === "--ci";

if (ciMode) {
  console.log("CI Mode: Checking for GPL/AGPL dependencies...\n");
} else if (packageName) {
  console.log(`Looking up license for: ${packageName}\n`);
} else {
  console.log("Checking licenses for all dependencies...\n");
}

(async () => {
  try {
    const rootDir = path.join(__dirname, "..");
    const licenseMap = new Map();

    // Find all node_modules directories
    function findNodeModules(dir, depth = 0) {
      if (depth > 10) return []; // Prevent infinite recursion

      const nodeModulesPath = path.join(dir, "node_modules");
      if (!fs.existsSync(nodeModulesPath)) return [];

      const results = [nodeModulesPath];

      // Also check workspaces
      const packageJsonPath = path.join(dir, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
          if (pkg.workspaces) {
            const workspaces = Array.isArray(pkg.workspaces)
              ? pkg.workspaces
              : pkg.workspaces.packages || [];
            for (const workspace of workspaces) {
              const workspacePath = path.join(
                dir,
                workspace.replace(/\/\*$/, ""),
              );
              if (fs.existsSync(workspacePath)) {
                const subdirs = fs.readdirSync(workspacePath, {
                  withFileTypes: true,
                });
                for (const subdir of subdirs) {
                  if (subdir.isDirectory()) {
                    results.push(
                      ...findNodeModules(
                        path.join(workspacePath, subdir.name),
                        depth + 1,
                      ),
                    );
                  }
                }
              }
            }
          }
        } catch (_e) {
          // Ignore parsing errors
        }
      }

      return results;
    }

    // Read all packages from node_modules
    function scanNodeModules(nodeModulesPath) {
      if (!fs.existsSync(nodeModulesPath)) return;

      // Scan .pnpm virtual store (contains all packages in isolated mode)
      // Note: In hoisted mode (node-linker=hoisted), .pnpm won't exist and
      // top-level node_modules scanning would be needed. We only support
      // pnpm's default isolated mode.
      const pnpmPath = path.join(nodeModulesPath, ".pnpm");
      if (fs.existsSync(pnpmPath)) {
        scanPnpmStore(pnpmPath);
      }
    }

    // Scan pnpm virtual store
    function scanPnpmStore(pnpmPath) {
      const entries = fs.readdirSync(pnpmPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Entry format: package@version or @scope+package@version
        // Extract package name and find its node_modules
        const pkgPath = path.join(pnpmPath, entry.name, "node_modules");

        if (fs.existsSync(pkgPath)) {
          // Scan this package's node_modules
          const pkgEntries = fs.readdirSync(pkgPath, { withFileTypes: true });

          for (const pkgEntry of pkgEntries) {
            if (pkgEntry.name.startsWith("@")) {
              // Scoped package
              const scopePath = path.join(pkgPath, pkgEntry.name);
              if (fs.existsSync(scopePath)) {
                const scopedEntries = fs.readdirSync(scopePath, {
                  withFileTypes: true,
                });
                for (const scopedEntry of scopedEntries) {
                  if (scopedEntry.isDirectory()) {
                    const pkgName = `${pkgEntry.name}/${scopedEntry.name}`;
                    const pkgJsonPath = path.join(
                      scopePath,
                      scopedEntry.name,
                      "package.json",
                    );
                    readPackageJson(pkgName, pkgJsonPath);
                  }
                }
              }
            } else if (pkgEntry.isDirectory()) {
              const pkgName = pkgEntry.name;
              const pkgJsonPath = path.join(
                pkgPath,
                pkgEntry.name,
                "package.json",
              );
              readPackageJson(pkgName, pkgJsonPath);
            }
          }
        }
      }
    }

    // Detect license from LICENSE file content
    function detectLicenseFromFile(content) {
      const contentUpper = content.toUpperCase();

      // Check for common license patterns
      if (contentUpper.includes("MIT LICENSE")) return "MIT";
      if (contentUpper.includes("APACHE LICENSE")) return "Apache-2.0";
      if (contentUpper.includes("BSD 3-CLAUSE")) return "BSD-3-Clause";
      if (contentUpper.includes("BSD 2-CLAUSE")) return "BSD-2-Clause";
      if (contentUpper.includes("ISC LICENSE")) return "ISC";
      if (contentUpper.includes("GNU GENERAL PUBLIC LICENSE")) {
        if (contentUpper.includes("VERSION 3")) return "GPL-3.0";
        if (contentUpper.includes("VERSION 2")) return "GPL-2.0";
        return "GPL";
      }
      if (contentUpper.includes("GNU LESSER GENERAL PUBLIC LICENSE")) {
        if (contentUpper.includes("VERSION 3")) return "LGPL-3.0";
        if (contentUpper.includes("VERSION 2")) return "LGPL-2.1";
        return "LGPL";
      }
      if (contentUpper.includes("GNU AFFERO GENERAL PUBLIC LICENSE"))
        return "AGPL-3.0";
      if (contentUpper.includes("MOZILLA PUBLIC LICENSE")) return "MPL-2.0";
      if (
        contentUpper.includes("UNLICENSE") ||
        contentUpper.includes("PUBLIC DOMAIN")
      )
        return "Unlicense";
      if (contentUpper.includes("CREATIVE COMMONS")) {
        if (contentUpper.includes("CC0")) return "CC0-1.0";
        if (contentUpper.includes("CC-BY-4.0")) return "CC-BY-4.0";
      }
      if (contentUpper.includes("BLUEOAK-1.0.0")) return "BlueOak-1.0.0";
      if (contentUpper.includes("WTFPL")) return "WTFPL";
      if (contentUpper.includes("PYTHON SOFTWARE FOUNDATION"))
        return "Python-2.0";

      return null;
    }

    function readPackageJson(name, pkgPath) {
      if (licenseMap.has(name)) return;

      try {
        if (!fs.existsSync(pkgPath)) return;

        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        let license = pkg.license || pkg.licenses?.[0]?.type || pkg.licenses;
        const version = pkg.version || "unknown";

        // If no license in package.json or it's unknown, try to read LICENSE file
        if (
          !license ||
          license === "Unknown" ||
          license === "UNKNOWN" ||
          license === "SEE LICENSE IN LICENSE"
        ) {
          const pkgDir = path.dirname(pkgPath);
          const licenseFiles = [
            "LICENSE",
            "license",
            "LICENCE",
            "licence",
            "LICENSE.md",
            "LICENSE.txt",
            "license.txt",
            "COPYING",
            "LICENSE-MIT",
            "LICENSE-APACHE",
          ];

          for (const licenseFile of licenseFiles) {
            const licensePath = path.join(pkgDir, licenseFile);
            if (fs.existsSync(licensePath)) {
              try {
                const licenseContent = fs.readFileSync(licensePath, "utf-8");
                const detectedLicense = detectLicenseFromFile(licenseContent);
                if (detectedLicense) {
                  license = detectedLicense;
                  break;
                }
              } catch (_e) {
                // Continue to next file
              }
            }
          }
        }

        if (!license) license = "Unknown";

        licenseMap.set(name, {
          version,
          license:
            typeof license === "object" ? JSON.stringify(license) : license,
        });
      } catch (_e) {
        // Ignore unreadable packages
      }
    }

    // Scan all node_modules
    const nodeModulesDirs = findNodeModules(rootDir);
    console.log(
      `Scanning ${nodeModulesDirs.length} node_modules directories...`,
    );

    for (const dir of nodeModulesDirs) {
      scanNodeModules(dir);
    }

    // For Unknown or generic licenses, try npm registry lookup
    const unknownPackages = [];
    for (const [name, info] of licenseMap.entries()) {
      if (
        info.license === "Unknown" ||
        info.license === "UNKNOWN" ||
        info.license === "SEE LICENSE IN LICENSE"
      ) {
        unknownPackages.push(name);
      }
    }

    // Categorize licenses
    function categorizeLicense(license) {
      // Handle dual licenses with OR (choose the permissive one)
      if (/ OR /i.test(license)) {
        const parts = license.split(/ OR /i);
        // Prefer permissive licenses: MIT > Apache > BSD > ISC > others
        for (const part of parts) {
          if (/MIT/i.test(part)) return "MIT (dual)";
          if (/APACHE/i.test(part)) return "Apache (dual)";
          if (/BSD/i.test(part)) return "BSD (dual)";
          if (/ISC/i.test(part)) return "ISC (dual)";
        }
        // If no permissive option, show as dual
        return `Dual: ${license}`;
      }

      // Handle AND licenses (must comply with both - stricter)
      if (/ AND /i.test(license)) {
        return `Multi: ${license}`;
      }

      // Single license categorization
      if (
        /GPL/i.test(license) &&
        !/LGPL/i.test(license) &&
        !/AGPL/i.test(license)
      )
        return "GPL";
      if (/LGPL/i.test(license)) return "LGPL";
      if (/AGPL/i.test(license)) return "AGPL";
      if (/MIT/i.test(license)) return "MIT";
      if (/APACHE/i.test(license)) return "Apache";
      if (/BSD/i.test(license)) return "BSD";
      if (/ISC/i.test(license)) return "ISC";
      if (/CC0/i.test(license)) return "CC0";
      if (/CC-BY/i.test(license)) return "CC-BY";
      if (/CREATIVE COMMONS/i.test(license)) return "CC";
      if (/UNLICENSE/i.test(license)) return "Unlicense";
      if (/^0BSD$/i.test(license)) return "0BSD";
      if (/MPL/i.test(license)) return "MPL";
      if (/BLUEOAK/i.test(license)) return "BlueOak";
      if (/WTFPL/i.test(license)) return "WTFPL";
      if (/PYTHON/i.test(license)) return "Python";
      if (license === "Unknown") return "Unknown";

      return "Other";
    }

    // Handle CI mode
    if (ciMode) {
      const problematicPackages = [];
      const verifiedPackages = [];

      for (const [name, { version, license }] of licenseMap.entries()) {
        let effectiveLicense = license;
        let category = categorizeLicense(license);

        // Check if Unknown license is in allowlist
        if (category === "Unknown" && VERIFIED_LICENSES[name]) {
          const verified = VERIFIED_LICENSES[name];
          effectiveLicense = verified.license;
          category = categorizeLicense(verified.license);
          verifiedPackages.push({
            name,
            version,
            license: verified.license,
            source: verified.source,
          });
          // Continue checking with verified license
        }

        // Dual licenses with permissive option are OK
        if (category.includes("(dual)")) continue;

        // Pure GPL/AGPL are problematic
        if (category === "GPL" || category === "AGPL") {
          problematicPackages.push({
            name,
            version,
            license: effectiveLicense,
            category,
          });
        }

        // Multi-license with AND containing GPL is problematic
        if (
          category.startsWith("Multi:") &&
          /GPL/i.test(effectiveLicense) &&
          !/LGPL/i.test(effectiveLicense)
        ) {
          problematicPackages.push({
            name,
            version,
            license: effectiveLicense,
            category: "GPL (multi)",
          });
        }

        // Unknown licenses not in allowlist are problematic
        if (category === "Unknown" && !VERIFIED_LICENSES[name]) {
          problematicPackages.push({
            name,
            version,
            license: effectiveLicense,
            category,
          });
        }
      }

      if (problematicPackages.length === 0) {
        console.log("✅ No GPL/AGPL/Unknown dependencies found!");

        // Show manually verified packages
        if (verifiedPackages.length > 0) {
          console.log("\nManually verified licenses (from allowlist):");
          for (const { name, version, license, source } of verifiedPackages) {
            console.log(`  ✓ ${name}@${version} - ${license}`);
            console.log(`    Source: ${source}`);
          }
        }

        // Show LGPL packages
        console.log(
          "\nLGPL packages (dynamically linked, usually acceptable):",
        );
        const lgplPackages = [];
        for (const [name, { version, license }] of licenseMap.entries()) {
          const category = categorizeLicense(license);
          if (category === "LGPL") {
            lgplPackages.push({ name, version, license });
          }
        }

        if (lgplPackages.length > 0) {
          for (const { name, version, license } of lgplPackages) {
            console.log(`  - ${name}@${version} (${license})`);
          }
        } else {
          console.log("  (none)");
        }

        process.exit(0);
      }

      console.error(
        `❌ Found ${problematicPackages.length} problematic dependencies:\n`,
      );
      for (const { name, version, license, category } of problematicPackages) {
        console.error(`  [${category}] ${name}@${version} - ${license}`);
      }
      console.error("\nTo fix:");
      console.error("  - For GPL/AGPL: Remove or find MIT/Apache alternatives");
      console.error(
        "  - For Unknown: Verify license and add to VERIFIED_LICENSES in script",
      );
      console.error(
        "\nTo investigate: pnpm list <package-name> -r --depth=Infinity",
      );
      process.exit(1);
    }

    // Handle lookup mode
    if (filterType === "lookup") {
      if (!packageName) {
        console.error("Error: Package name required for lookup mode");
        console.log(
          "\nUsage: tsx license-check.ts lookup <package-name>",
        );
        process.exit(1);
      }

      const pkgInfo = licenseMap.get(packageName);
      if (!pkgInfo) {
        console.error(`Package "${packageName}" not found in dependencies`);
        console.log(`\nTry running: pnpm list ${packageName}`);
        process.exit(1);
      }

      let category = categorizeLicense(pkgInfo.license);
      let verifiedInfo = null;

      // Check if verified from allowlist
      if (pkgInfo.license === "Unknown" && VERIFIED_LICENSES[packageName]) {
        verifiedInfo = VERIFIED_LICENSES[packageName];
        category = `${categorizeLicense(verifiedInfo.license)} (unknown but verified)`;
      }

      console.log(`Package: ${packageName}`);
      console.log(`Version: ${pkgInfo.version}`);
      console.log(`License: ${pkgInfo.license}`);
      console.log(`Category: ${category}`);

      if (verifiedInfo) {
        console.log(`\n✓ Manually verified from: ${verifiedInfo.source}`);
        console.log(`  Verified license: ${verifiedInfo.license}`);
      }

      console.log("\nTo see why this dependency is included:");
      console.log(`  pnpm list ${packageName} -r --depth=Infinity`);
      process.exit(0);
    }

    // Filter and display results
    const results = [];
    for (const [name, { version, license }] of licenseMap.entries()) {
      let category = categorizeLicense(license);
      let isVerified = false;

      // Check if this was verified from allowlist
      if (license === "Unknown" && VERIFIED_LICENSES[name]) {
        const verified = VERIFIED_LICENSES[name];
        category = `${categorizeLicense(verified.license)} (verified)`;
        isVerified = true;
      }

      if (filterType) {
        const filterUpper = filterType.toUpperCase();
        const baseCategory = category.replace(" (verified)", "");
        if (
          filterUpper === "GPL" &&
          !["GPL", "LGPL", "AGPL"].includes(baseCategory)
        )
          continue;
        if (filterUpper === "MIT" && baseCategory !== "MIT") continue;
        if (filterUpper === "APACHE" && !baseCategory.includes("Apache"))
          continue;
        if (filterUpper === "BSD" && baseCategory !== "BSD") continue;
        if (filterUpper === "ISC" && baseCategory !== "ISC") continue;
        if (
          filterUpper === "OTHER" &&
          [
            "GPL",
            "LGPL",
            "AGPL",
            "MIT",
            "Apache",
            "BSD",
            "ISC",
            "CC0",
            "Unlicense",
            "0BSD",
            "MPL",
          ].includes(baseCategory)
        )
          continue;
      }

      results.push({ name, version, license, category, isVerified });
    }

    // License restrictiveness ranking (lower = more permissive, higher = more restrictive)
    function getRestrictiveness(category) {
      const baseCategory = category
        .replace(" (verified)", "")
        .replace(" (dual)", "");

      // Public domain (most permissive)
      if (
        baseCategory === "Unlicense" ||
        baseCategory === "CC0" ||
        baseCategory === "WTFPL"
      )
        return 0;

      // Very permissive
      if (baseCategory === "0BSD") return 1;
      if (baseCategory === "MIT") return 2;
      if (baseCategory === "BSD") return 3;
      if (baseCategory === "ISC") return 4;
      if (baseCategory === "Apache") return 5;
      if (baseCategory === "Python") return 6;
      if (baseCategory === "BlueOak") return 7;

      // Attribution required
      if (baseCategory.startsWith("CC-BY")) return 10;
      if (baseCategory === "CC") return 11;

      // Weak copyleft
      if (baseCategory === "MPL") return 20;
      if (baseCategory === "LGPL") return 21;

      // Multi-license (depends on content)
      if (baseCategory.startsWith("Multi:")) return 30;

      // Strong copyleft (most restrictive)
      if (baseCategory === "GPL") return 100;
      if (baseCategory === "AGPL") return 101;

      // Unknown/Other (problematic - should investigate)
      if (baseCategory === "Other") return 200;
      if (baseCategory === "Unknown") return 201;

      // Default (unknown pattern)
      return 150;
    }

    // Sort by restrictiveness (most permissive first), then name
    results.sort((a, b) => {
      const restrictA = getRestrictiveness(a.category);
      const restrictB = getRestrictiveness(b.category);
      if (restrictA !== restrictB) return restrictA - restrictB;
      return a.name.localeCompare(b.name);
    });

    // Count by category
    const categoryCounts = {};
    for (const { category } of results) {
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    // License explanations
    function getLicenseExplanation(category) {
      const baseCategory = category
        .replace(" (verified)", "")
        .replace(" (dual)", "");

      switch (baseCategory) {
        case "CC0":
          return "Public domain dedication. No restrictions whatsoever.";
        case "Unlicense":
          return "Public domain dedication. Anyone can do anything with the code.";
        case "WTFPL":
          return "Do What The Fuck You Want To Public License. Extremely permissive, equivalent to public domain.";
        case "0BSD":
          return "Zero-Clause BSD. Permissive license without even an attribution requirement.";
        case "MIT":
          return "Very permissive. Allows commercial use, modification, distribution. Requires only license/copyright notice.";
        case "BSD":
          return "Permissive license similar to MIT. Requires attribution and disclaimer of warranty.";
        case "ISC":
          return "Functionally equivalent to MIT. Simple permissive license from OpenBSD.";
        case "Apache":
          return "Permissive like MIT but with explicit patent grant. Requires attribution and notices.";
        case "Python":
          return "Python Software Foundation License. BSD-style permissive license.";
        case "BlueOak":
          return "Modern permissive license designed to be clearer than MIT/BSD.";
        case "CC-BY":
          return "Creative Commons Attribution. Requires attribution to original author.";
        case "CC":
          return "Creative Commons license. Typically requires attribution.";
        case "MPL":
          return "Mozilla Public License. Weak copyleft at file level only. Modified MPL files must be shared, but can be combined with proprietary code.";
        case "LGPL":
          return "Lesser GPL. Weak copyleft. Can be used in proprietary software if dynamically linked. Modified LGPL code must be shared.";
        case "GPL":
          return "⚠️ Strong copyleft. Requires entire work to be open-sourced under GPL. Incompatible with proprietary software.";
        case "AGPL":
          return "⚠️ Affero GPL. Like GPL but triggered by network use. Incompatible with proprietary software.";
        case "Unknown":
          return "⚠️ License cannot be determined. Without a license, all rights are reserved - cannot legally use without permission.";
        case "Other":
          return "⚠️ Unrecognized license type. Requires manual review.";
        default:
          if (baseCategory.startsWith("Multi:")) {
            return "Multiple licenses with AND operator. Must comply with all licenses listed.";
          }
          return "License requires manual review.";
      }
    }

    // Display results
    console.log(
      `\nFound ${results.length} packages${filterType ? ` (filter: ${filterType.toUpperCase()})` : ""}:\n`,
    );

    const sortedCategories = Object.entries(categoryCounts).sort((a, b) => {
      // Sort by restrictiveness (most permissive first, problematic last)
      return getRestrictiveness(a[0]) - getRestrictiveness(b[0]);
    });

    console.log("=".repeat(100));
    console.log("LICENSE REPORT");
    console.log("=".repeat(100));
    console.log("\nSorted by restrictiveness (permissive → restrictive)\n");

    for (const [category, count] of sortedCategories) {
      const explanation = getLicenseExplanation(category);
      console.log(`[${category}] - ${count} package${count === 1 ? "" : "s"}`);
      console.log(`  ${explanation}\n`);
    }

    console.log("=".repeat(100));
    console.log(
      "\nLicense distribution (sorted by restrictiveness - permissive → restrictive):",
    );
    for (const [category, count] of sortedCategories) {
      console.log(`  ${category}: ${count}`);
    }

    console.log(`\n${"─".repeat(100)}`);

    const hasVerified = results.some((r) => r.isVerified);
    if (hasVerified) {
      console.log(
        "Note: (verified) = License manually verified from external source (see VERIFIED_LICENSES in script)\n",
      );
    }

    for (const { name, version, license, category } of results) {
      const baseCategory = category
        .replace(" (verified)", "")
        .replace(" (dual)", "");
      const isProblematic =
        ["GPL", "AGPL", "Unknown", "Other"].includes(baseCategory) ||
        (baseCategory.startsWith("Multi:") &&
          /GPL/i.test(baseCategory) &&
          !/LGPL/i.test(baseCategory));
      const warning = isProblematic ? "⚠️  " : "";
      const tag = `[${category}]`;
      console.log(
        `${warning}${tag.padEnd(25)} ${name}@${version} - ${license}`,
      );
    }
  } catch (error) {
    console.error("Error checking licenses:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
