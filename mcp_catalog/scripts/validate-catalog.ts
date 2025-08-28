#!/usr/bin/env tsx
import fs from 'fs/promises';
import path from 'path';

import { ArchestraMcpServerManifestSchema } from '@schemas';

import { MCP_SERVERS_EVALUATIONS_DIR } from './paths';

interface ValidationError {
  file: string;
  errors: any;
}

async function validateFile(filePath: string): Promise<{ valid: boolean; errors?: any }> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);

    const result = ArchestraMcpServerManifestSchema.safeParse(data);

    if (!result.success) {
      return {
        valid: false,
        errors: result.error.format(),
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function main() {
  console.log('Starting MCP catalog validation...\n');

  try {
    // Get all JSON files in the mcp-evaluations directory
    const files = await fs.readdir(MCP_SERVERS_EVALUATIONS_DIR);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    console.log(`Found ${jsonFiles.length} JSON files to validate\n`);

    let validCount = 0;
    let invalidCount = 0;
    const validationErrors: ValidationError[] = [];

    // Validate each file
    for (const file of jsonFiles) {
      const filePath = path.join(MCP_SERVERS_EVALUATIONS_DIR, file);
      process.stdout.write(`Validating ${file}... `);

      const result = await validateFile(filePath);

      if (result.valid) {
        console.log('✓');
        validCount++;
      } else {
        console.log('✗');
        invalidCount++;
        validationErrors.push({
          file,
          errors: result.errors,
        });
      }
    }

    console.log('\n=== Validation Summary ===');
    console.log(`✓ Valid files: ${validCount}`);
    console.log(`✗ Invalid files: ${invalidCount}`);

    if (validationErrors.length > 0) {
      console.log('\n=== Validation Errors ===');
      for (const { file, errors } of validationErrors) {
        console.log(`\n${file}:`);
        console.log(JSON.stringify(errors, null, 2));
      }

      // Exit with error code if any files are invalid
      process.exit(1);
    }

    console.log('\n✅ All files are valid!');
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run the validation if this script is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
}
