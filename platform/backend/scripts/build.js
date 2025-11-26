#!/usr/bin/env node

import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🏗️  Building backend...');

// Clean and build with TypeScript compiler
console.log('📦 Compiling TypeScript...');
try {
  execSync('tsc', { cwd: projectRoot, stdio: 'inherit' });
} catch (error) {
  console.error('❌ TypeScript compilation failed');
  process.exit(1);
}

// Copy SQL migration files
console.log('📄 Copying SQL migration files...');
const srcMigrationsDir = join(projectRoot, 'src', 'database', 'migrations');
const distMigrationsDir = join(projectRoot, 'dist', 'database', 'migrations');

function copyDirectory(src, dest) {
  try {
    mkdirSync(dest, { recursive: true });
    
    const entries = readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      
      if (statSync(srcPath).isDirectory()) {
        copyDirectory(srcPath, destPath);
      } else if (entry.endsWith('.sql')) {
        copyFileSync(srcPath, destPath);
        console.log(`   ✅ Copied ${relative(projectRoot, srcPath)}`);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`❌ Error copying directory ${src}:`, error.message);
      process.exit(1);
    }
  }
}

copyDirectory(srcMigrationsDir, distMigrationsDir);

console.log('✅ Backend build completed successfully!');
