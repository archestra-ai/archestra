interface LogEntry {
  timestamp: string;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  args: any[];
}

class FrontendLogCapture {
  private logs: LogEntry[] = [];
  private maxLogs = 500;
  private originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };

  constructor() {
    this.interceptConsole();
  }

  private interceptConsole() {
    // Intercept console methods
    console.log = (...args) => {
      this.addLog('log', args);
      this.originalConsole.log(...args);
    };

    console.warn = (...args) => {
      this.addLog('warn', args);
      this.originalConsole.warn(...args);
    };

    console.error = (...args) => {
      this.addLog('error', args);
      this.originalConsole.error(...args);
    };

    console.info = (...args) => {
      this.addLog('info', args);
      this.originalConsole.info(...args);
    };

    console.debug = (...args) => {
      this.addLog('debug', args);
      this.originalConsole.debug(...args);
    };
  }

  private addLog(level: LogEntry['level'], args: any[]) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: this.formatMessage(args),
      args,
    };

    this.logs.push(entry);

    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }

  private formatMessage(args: any[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public getFormattedLogs(): string {
    return this.logs
      .map((log) => {
        const timestamp = new Date(log.timestamp).toLocaleTimeString();
        const levelPrefix = `[${log.level.toUpperCase().padEnd(5)}]`;
        return `[${timestamp}] ${levelPrefix} ${log.message}`;
      })
      .join('\n');
  }

  public clear() {
    this.logs = [];
  }
}

// Create singleton instance
const logCapture = new FrontendLogCapture();

export default logCapture;
export type { LogEntry };
