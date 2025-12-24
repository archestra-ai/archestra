/**
 * ARCHESTRA BROWSER STREAM SERVICE
 * Enterprise-grade browser automation with security guardrails
 * 
 * Fixes from it-baron PR #1432:
 * - Tab isolation: conversationId → browserContextId binding
 * - Cleanup: onConversationDelete lifecycle hook
 * - Address bar sync: Single source from page.url()
 */

import type { BrowserContext, Page, Browser } from 'playwright';
import { chromium } from 'playwright';
import type { WebSocket } from 'ws';
import { BrowserSecurityValidator } from './browser-security';
import type { BrowserAction, BrowserSession, DomainPolicy } from './types';
import logger from '@/logging';

export class BrowserStreamService {
  // Session isolation - the key bug fix from PR #1432
  private sessions: Map<string, BrowserSession> = new Map();
  private securityValidator: BrowserSecurityValidator;
  
  // Screenshot streaming config
  private readonly SCREENSHOT_INTERVAL_MS = 100; // 10 FPS
  private readonly MAX_SCREENSHOT_QUALITY = 80;
  
  constructor(securityValidator: BrowserSecurityValidator) {
    this.securityValidator = securityValidator;
  }
  
  /**
   * Create isolated browser session for a conversation
   * Key fix: Each conversation gets its own BrowserContext
   */
  async createSession(
    conversationId: string,
    orgPolicy: DomainPolicy
  ): Promise<BrowserSession> {
    // Prevent duplicate sessions
    if (this.sessions.has(conversationId)) {
      throw new Error(`Session already exists for conversation: ${conversationId}`);
    }
    
    // Launch browser with isolation
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--no-sandbox',
      ],
    });
    
    // Create isolated context - each conversation is sandboxed
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Archestra Browser MCP/1.0',
    });
    
    const page = await context.newPage();
    
    const session: BrowserSession = {
      conversationId,
      browser,
      context,
      page,
      orgPolicy,
      isUserControlled: false,
      actions: [],
      createdAt: new Date(),
    };
    
    this.sessions.set(conversationId, session);
    
    // Setup navigation listener for address bar sync
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        this.onPageNavigate(conversationId, page.url());
      }
    });
    
    logger.info({ conversationId }, 'Browser session created');
    
    return session;
  }
  
  /**
   * Destroy session and cleanup resources
   * Critical fix: Called on conversation delete
   */
  async destroySession(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId);
    if (!session) return;
    
    try {
      await session.context.close();
      await session.browser.close();
    } catch (error) {
      logger.error({ conversationId, error }, 'Error destroying browser session');
    } finally {
      this.sessions.delete(conversationId);
      logger.info({ conversationId }, 'Browser session destroyed');
    }
  }
  
  /**
   * Navigate to URL with security validation
   */
  async navigate(
    conversationId: string,
    url: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(conversationId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    
    // Security validation through Prolog rules
    const validation = await this.securityValidator.validateUrl(url, session.orgPolicy);
    
    if (!validation.allowed) {
      // Log blocked action
      this.logAction(conversationId, {
        type: 'navigate',
        target: url,
        userId,
        result: 'blocked',
        blockReason: validation.reason,
        timestamp: new Date(),
      });
      
      return { success: false, error: validation.reason };
    }
    
    try {
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
      
      this.logAction(conversationId, {
        type: 'navigate',
        target: url,
        userId,
        result: 'allowed',
        timestamp: new Date(),
      });
      
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Navigation failed' 
      };
    }
  }
  
  /**
   * Type text with secret detection
   */
  async type(
    conversationId: string,
    selector: string,
    text: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(conversationId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    
    // Secret detection through security rules
    const validation = await this.securityValidator.validateInput(text);
    
    if (!validation.allowed) {
      this.logAction(conversationId, {
        type: 'type',
        target: selector,
        userId,
        result: 'blocked',
        blockReason: 'Secret detected - credential entry blocked',
        timestamp: new Date(),
      });
      
      return { success: false, error: 'Credential entry blocked for security' };
    }
    
    try {
      await session.page.type(selector, text);
      
      this.logAction(conversationId, {
        type: 'type',
        target: selector,
        userId,
        result: 'allowed',
        timestamp: new Date(),
      });
      
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Type failed' 
      };
    }
  }
  
  /**
   * Click on element
   */
  async click(
    conversationId: string,
    selector: string,
    userId: string
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.sessions.get(conversationId);
    if (!session) {
      return { success: false, error: 'Session not found' };
    }
    
    try {
      await session.page.click(selector);
      
      this.logAction(conversationId, {
        type: 'click',
        target: selector,
        userId,
        result: 'allowed',
        timestamp: new Date(),
      });
      
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        error: error instanceof Error ? error.message : 'Click failed' 
      };
    }
  }
  
  /**
   * Take screenshot
   */
  async screenshot(conversationId: string): Promise<Buffer | null> {
    const session = this.sessions.get(conversationId);
    if (!session) return null;
    
    try {
      return await session.page.screenshot({
        type: 'jpeg',
        quality: this.MAX_SCREENSHOT_QUALITY,
      });
    } catch {
      return null;
    }
  }
  
  /**
   * Stream screenshots to WebSocket client
   */
  streamScreenshots(ws: WebSocket, conversationId: string): () => void {
    const session = this.sessions.get(conversationId);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
      return () => {};
    }
    
    const intervalId = setInterval(async () => {
      try {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(intervalId);
          return;
        }
        
        const screenshot = await session.page.screenshot({
          type: 'jpeg',
          quality: this.MAX_SCREENSHOT_QUALITY,
        });
        
        ws.send(JSON.stringify({
          type: 'screenshot',
          data: screenshot.toString('base64'),
          url: session.page.url(), // Single source of truth for address bar
          timestamp: Date.now(),
        }));
      } catch (error) {
        logger.error({ conversationId, error }, 'Screenshot stream error');
      }
    }, this.SCREENSHOT_INTERVAL_MS);
    
    // Return cleanup function
    return () => clearInterval(intervalId);
  }
  
  /**
   * Auth handoff - human takes control
   */
  async takeControl(conversationId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    
    session.isUserControlled = true;
    
    this.logAction(conversationId, {
      type: 'auth_handoff',
      target: 'user',
      userId,
      result: 'allowed',
      timestamp: new Date(),
    });
    
    return true;
  }
  
  /**
   * Return control to AI agent
   */
  async returnControl(conversationId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!session) return false;
    
    session.isUserControlled = false;
    
    this.logAction(conversationId, {
      type: 'auth_handoff',
      target: 'agent',
      userId,
      result: 'allowed',
      timestamp: new Date(),
    });
    
    return true;
  }
  
  /**
   * Handle page navigation event
   */
  onPageNavigate(conversationId: string, url: string): void {
    logger.debug({ conversationId, url }, 'Page navigated');
  }
  
  /**
   * Log action for audit trail
   */
  private logAction(conversationId: string, action: BrowserAction): void {
    const session = this.sessions.get(conversationId);
    if (session) {
      session.actions.push(action);
    }
    
    logger.info({ conversationId, action: action.type, result: action.result }, 'Browser action');
  }
  
  /**
   * Get action log for conversation
   */
  getActionLog(conversationId: string): BrowserAction[] {
    return this.sessions.get(conversationId)?.actions ?? [];
  }
  
  /**
   * Get current URL (single source of truth)
   */
  getCurrentUrl(conversationId: string): string | null {
    const session = this.sessions.get(conversationId);
    return session?.page.url() ?? null;
  }
  
  /**
   * Check if user has control
   */
  isUserControlled(conversationId: string): boolean {
    return this.sessions.get(conversationId)?.isUserControlled ?? false;
  }
  
  /**
   * Cleanup all sessions - for graceful shutdown
   */
  async shutdown(): Promise<void> {
    const cleanupPromises = Array.from(this.sessions.keys()).map(
      (id) => this.destroySession(id)
    );
    await Promise.all(cleanupPromises);
    logger.info('All browser sessions cleaned up');
  }
}

export default BrowserStreamService;
