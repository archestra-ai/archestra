// Test if logger can access LOGS_DIRECTORY
const path = require('path');

// Mock app.getPath since we're testing outside of Electron
const mockGetPath = (name) => {
  if (name === 'logs') {
    return path.join(process.env.HOME || process.env.USERPROFILE, 'Library/Logs/Archestra');
  }
  if (name === 'userData') {
    return path.join(process.env.HOME || process.env.USERPROFILE, 'Library/Application Support/archestra');
  }
  throw new Error(`Unknown path: ${name}`);
};

// Test the path resolution
try {
  const logsDir = mockGetPath('logs');
  console.log('LOGS_DIRECTORY would be:', logsDir);
  console.log('main.log would be at:', path.join(logsDir, 'main.log'));
  
  const userDataDir = mockGetPath('userData');
  console.log('USER_DATA_DIRECTORY would be:', userDataDir);
} catch (error) {
  console.error('Error:', error.message);
}