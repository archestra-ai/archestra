import { ModelMessage } from 'ai';
import fs from 'node:fs';
import path from 'node:path';

import { TaintedContext } from './security/types';

/**
 * The string key here represents a session ID
 */
type ContextData = Record<string, ModelMessage[]>;

/**
 * The string key here represents a session ID
 *
 * The string key inside the nested object, represents a tool call ID
 */
type TaintedContextData = Record<string, Record<string, TaintedContext>>;

const PERSISTENCE_DIR = path.join(__dirname);

/**
 * In our real application, we would persist this in some database/cache
 * For now, we'll just persist it to a local .gitignore'd file
 */
class Context {
  private sessionContextFile = path.join(PERSISTENCE_DIR, 'session.json');

  constructor() {
    // Create the session file if it doesn't exist
    if (!fs.existsSync(this.sessionContextFile)) {
      fs.writeFileSync(this.sessionContextFile, JSON.stringify({}));
    }
  }

  private getAllSessionData() {
    return JSON.parse(
      fs.readFileSync(this.sessionContextFile, 'utf8')
    ) as ContextData;
  }

  updateSessionContext(sessionId: string, context: ModelMessage[]) {
    const updatedSessionData = this.getAllSessionData();
    updatedSessionData[sessionId] = context;
    fs.writeFileSync(
      this.sessionContextFile,
      JSON.stringify(updatedSessionData, null, 2)
    );
  }

  getSessionContext(sessionId: string) {
    return this.getAllSessionData()[sessionId] || [];
  }
}

/**
 * Context map to track tainted data throughout a session
 * In our real application, we would persist this in some database/cache. For now, we'll just store this in memory
 */
class TaintedContextSourceData {
  private sessionTaintedContextFile = path.join(
    PERSISTENCE_DIR,
    'session-tainted-contexts.json'
  );

  constructor() {
    // Create the session tainted contexts file if it doesn't exist
    if (!fs.existsSync(this.sessionTaintedContextFile)) {
      fs.writeFileSync(this.sessionTaintedContextFile, JSON.stringify({}));
    }
  }

  private getAllTaintedContexts() {
    return JSON.parse(
      fs.readFileSync(this.sessionTaintedContextFile, 'utf8')
    ) as TaintedContextData;
  }

  addTaintedContext(sessionId: string, context: TaintedContext): void {
    const updatedTaintedContexts = this.getAllTaintedContexts();
    updatedTaintedContexts[sessionId] = {
      ...updatedTaintedContexts[sessionId],
      [context.toolCallId]: context,
    };
    fs.writeFileSync(
      this.sessionTaintedContextFile,
      JSON.stringify(updatedTaintedContexts, null, 2)
    );
  }

  hasTaintedData(sessionId: string): boolean {
    const sessionTaintedContexts = this.getAllTaintedContexts()[sessionId];

    return Object.values(sessionTaintedContexts || {}).some(
      (ctx) => ctx.isTainted
    );
  }

  getTaintedContexts(sessionId: string): TaintedContext[] {
    const sessionTaintedContexts = this.getAllTaintedContexts()[sessionId];

    return Object.values(sessionTaintedContexts || {}).filter(
      (ctx) => ctx.isTainted
    );
  }
}

export const context = new Context();
export const taintedContextSource = new TaintedContextSourceData();
