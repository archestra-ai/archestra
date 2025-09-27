import { ModelMessage } from 'ai';
import fs from 'node:fs';
import path from 'node:path';

const sessionFile = path.join(process.cwd(), 'session.json');

type PersistedSessionData = Record<string, ModelMessage[]>;

/**
 * In our real application, we would persist this in some database/cache
 *
 * For now, we'll just persist it to a local .gitignore'd file
 */
class SesssionPersistence {
  constructor() {
    // Create the session file if it doesn't exist
    if (!fs.existsSync(sessionFile)) {
      fs.writeFileSync(sessionFile, JSON.stringify({}));
    }
  }

  private getAllSessionData() {
    return JSON.parse(
      fs.readFileSync(sessionFile, 'utf8')
    ) as PersistedSessionData;
  }

  updateSessionContext(sessionId: string, context: ModelMessage[]) {
    const updatedSessionData = this.getAllSessionData();
    updatedSessionData[sessionId] = context;
    fs.writeFileSync(sessionFile, JSON.stringify(updatedSessionData, null, 2));
  }

  getSessionContext(sessionId: string) {
    return this.getAllSessionData()[sessionId] || [];
  }
}

export const sessionPersistence = new SesssionPersistence();
