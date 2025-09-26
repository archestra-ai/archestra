class Logger {
  prefix = 'Archestra: ';
  color = '\x1b[45m'; // magenta
  logger = console;

  info(message: string) {
    this.logger.info(this.formatMessage(message));
  }

  error(message: string) {
    this.logger.error(this.formatMessage(message));
  }

  warn(message: string) {
    this.logger.warn(this.formatMessage(message));
  }

  private formatMessage(message: string) {
    return `${this.color}${this.prefix}${message}\x1b[0m`;
  }
}

export const logger = new Logger();
