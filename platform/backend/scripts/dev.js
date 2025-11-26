#!/usr/bin/env node

import { spawn } from 'child_process';
import { watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🚀 Starting development server...');

let serverProcess = null;

function startServer() {
  if (serverProcess) {
    console.log('🔄 Restarting server...');
    serverProcess.kill();
  }
  
  serverProcess = spawn('node', ['--enable-source-maps', 'dist/server.js'], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
  
  serverProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.log(`❌ Server exited with code ${code}`);
    }
  });
}

// Initial build
console.log('📦 Initial build...');
const buildProcess = spawn('node', ['scripts/build.js'], {
  cwd: projectRoot,
  stdio: 'inherit'
});

buildProcess.on('exit', (code) => {
  if (code === 0) {
    console.log('✅ Initial build completed');
    startServer();
    
    // Watch for TypeScript changes
    console.log('👀 Watching for changes...');
    const tscWatch = spawn('tsc', ['--watch', '--preserveWatchOutput'], {
      cwd: projectRoot,
      stdio: 'pipe'
    });
    
    let isRebuilding = false;
    tscWatch.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(output);
      
      if (output.includes('Found 0 errors. Watching for file changes.')) {
        if (isRebuilding) {
          startServer();
          isRebuilding = false;
        }
      } else if (output.includes('File change detected. Starting incremental compilation...')) {
        isRebuilding = true;
      }
    });
    
    tscWatch.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    
    // Watch for SQL file changes
    const sqlWatcher = watch(join(projectRoot, 'src', 'database', 'migrations'), { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith('.sql')) {
        console.log(`📄 SQL file changed: ${filename}`);
        // Re-run build to copy SQL files
        const copyProcess = spawn('node', ['scripts/build.js'], {
          cwd: projectRoot,
          stdio: 'inherit'
        });
        copyProcess.on('exit', (code) => {
          if (code === 0) {
            startServer();
          }
        });
      }
    });
    
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down...');
      if (serverProcess) serverProcess.kill();
      tscWatch.kill();
      sqlWatcher.close();
      process.exit(0);
    });
    
  } else {
    console.error('❌ Initial build failed');
    process.exit(1);
  }
});
