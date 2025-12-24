/**
 * Browser Stream Service Tests
 * Tests for issue #1303 fixes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BrowserStreamService } from './browser-stream';
import { BrowserSecurityValidator } from './browser-security';

// Mock playwright
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue({
        newPage: vi.fn().mockResolvedValue({
          goto: vi.fn().mockResolvedValue(undefined),
          url: vi.fn().mockReturnValue('https://example.com'),
          click: vi.fn().mockResolvedValue(undefined),
          type: vi.fn().mockResolvedValue(undefined),
          screenshot: vi.fn().mockResolvedValue(Buffer.from('screenshot')),
          on: vi.fn(),
          mainFrame: vi.fn().mockReturnValue({}),
        }),
        close: vi.fn().mockResolvedValue(undefined),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// Mock logger
vi.mock('@/logging', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('BrowserStreamService', () => {
  let service: BrowserStreamService;
  let securityValidator: BrowserSecurityValidator;

  beforeEach(() => {
    securityValidator = new BrowserSecurityValidator();
    service = new BrowserStreamService(securityValidator);
  });

  afterEach(async () => {
    await service.shutdown();
  });

  describe('Session Isolation (PR #1432 bug fix)', () => {
    it('should create isolated sessions per conversation', async () => {
      const policy = { organizationId: 'org1' };
      
      const session1 = await service.createSession('conv1', policy);
      const session2 = await service.createSession('conv2', policy);
      
      expect(session1.conversationId).toBe('conv1');
      expect(session2.conversationId).toBe('conv2');
      expect(session1).not.toBe(session2);
    });

    it('should prevent duplicate sessions for same conversation', async () => {
      const policy = { organizationId: 'org1' };
      
      await service.createSession('conv1', policy);
      
      await expect(service.createSession('conv1', policy))
        .rejects
        .toThrow('Session already exists');
    });

    it('should cleanup session on destroy', async () => {
      const policy = { organizationId: 'org1' };
      
      await service.createSession('conv1', policy);
      expect(service.getCurrentUrl('conv1')).not.toBeNull();
      
      await service.destroySession('conv1');
      expect(service.getCurrentUrl('conv1')).toBeNull();
    });
  });

  describe('Navigation', () => {
    it('should navigate to allowed URLs', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const result = await service.navigate('conv1', 'https://example.com', 'user1');
      
      expect(result.success).toBe(true);
    });

    it('should block navigation to file:// URLs', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const result = await service.navigate('conv1', 'file:///etc/passwd', 'user1');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked scheme');
    });

    it('should block URLs not in allowlist', async () => {
      const policy = {
        organizationId: 'org1',
        allowlist: ['*.example.com'],
      };
      await service.createSession('conv1', policy);
      
      const result = await service.navigate('conv1', 'https://evil.com', 'user1');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('not in allowlist');
    });

    it('should block URLs in blocklist', async () => {
      const policy = {
        organizationId: 'org1',
        blocklist: ['evil.com'],
      };
      await service.createSession('conv1', policy);
      
      const result = await service.navigate('conv1', 'https://evil.com', 'user1');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked by policy');
    });
  });

  describe('Secret Detection', () => {
    it('should block typing passwords', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const result = await service.type('conv1', '#password', 'MyP@ssw0rd!', 'user1');
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
    });

    it('should block typing API keys', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const result = await service.type(
        'conv1',
        '#apikey',
        'sk-1234567890abcdefghij1234567890ab',
        'user1'
      );
      
      expect(result.success).toBe(false);
    });

    it('should block typing JWT tokens', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = await service.type('conv1', '#token', jwt, 'user1');
      
      expect(result.success).toBe(false);
    });

    it('should allow typing normal text', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      const result = await service.type('conv1', '#search', 'hello world', 'user1');
      
      expect(result.success).toBe(true);
    });
  });

  describe('Auth Handoff', () => {
    it('should allow user to take control', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      expect(service.isUserControlled('conv1')).toBe(false);
      
      const result = await service.takeControl('conv1', 'user1');
      
      expect(result).toBe(true);
      expect(service.isUserControlled('conv1')).toBe(true);
    });

    it('should allow user to return control', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      await service.takeControl('conv1', 'user1');
      
      const result = await service.returnControl('conv1', 'user1');
      
      expect(result).toBe(true);
      expect(service.isUserControlled('conv1')).toBe(false);
    });
  });

  describe('Audit Logging', () => {
    it('should log all actions', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      await service.navigate('conv1', 'https://example.com', 'user1');
      await service.click('conv1', '#button', 'user1');
      
      const log = service.getActionLog('conv1');
      
      expect(log.length).toBe(2);
      expect(log[0].type).toBe('navigate');
      expect(log[1].type).toBe('click');
    });

    it('should log blocked actions', async () => {
      const policy = { organizationId: 'org1' };
      await service.createSession('conv1', policy);
      
      await service.navigate('conv1', 'file:///etc/passwd', 'user1');
      
      const log = service.getActionLog('conv1');
      
      expect(log[0].result).toBe('blocked');
      expect(log[0].blockReason).toBeDefined();
    });
  });
});
