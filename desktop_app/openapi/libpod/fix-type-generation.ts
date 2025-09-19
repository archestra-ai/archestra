/**
 * There is an issue with the OpenAPI type generation with libpod swagger mixing type of Docker and PodmanAPI specs
 *
 * Specifically, the `Mount` type uses `Target` for Docker and `Destination` for Podman, but not both
 * This file provides utility functions to convert between the two types
 * See https://github.com/archestra-ai/archestra/pull/338#issuecomment-3278579082
 */
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to generated type file
const typesFilePath = path.join(__dirname, '../../src/backend/clients/libpod/gen/types.gen.ts');
function fixMountTypes() {
  console.log('🔧 Fixing types.gen.ts file...');

  if (!fs.existsSync(typesFilePath)) {
    console.error(`❌ File ${typesFilePath} does not exist`);
    console.log('Searched path:', typesFilePath);
    return;
  }

  try {
    let content = fs.readFileSync(typesFilePath, 'utf8');
    let modified = false;

    // Add Destination after Target (without replacing Target)
    if (content.includes('Target?: string;')) {
      content = content.replace(
        /(\s+Target\?\s*:\s*string;)/g,
        '$1\n  Destination?: string; // Podman API compatibility'
      );
      modified = true;
    }

    // Add RW after ReadOnly (without replacing ReadOnly) => not sure if useful
    if (content.includes('ReadOnly?: boolean;')) {
      content = content.replace(
        /(\s+ReadOnly\?\s*:\s*boolean;)/g,
        '$1\n  RW?: boolean; // Podman API compatibility - inverse of ReadOnly'
      );
      modified = true;
      console.log('✅ Add RW?: boolean;');
    }

    if (modified) {
      if (!content.includes('PODMAN TYPES FIXED')) {
        const warningComment = `/**
 * PODMAN TYPES FIXED - Added compatibility fields
 * - Added Mount.Destination alongside Mount.Target for Podman API
 * - Added Mount.RW alongside Mount.ReadOnly for Podman API compatibility
 *
 * Usage:
 * - Docker API: use Target and ReadOnly
 * - Podman API: use Destination, ReadOnly or RW
 */
`;
        // Insert the comment before the Mount type definition
        content = content.replace(/(export\s+type\s+Mount\s*=)/, warningComment + '$1');
      }

      fs.writeFileSync(typesFilePath, content);
      console.log('✅ types.gen.ts corrected successfully');
    }
  } catch (error) {
    console.error(`❌ Error while modifying:`, error.message);
  }
}

fixMountTypes();
console.log('✨ Types modified !');
