class Logger {
  prefix = '[Archestra] ';
  logger = console;

  info(message: string, color?: Color) {
    this.logger.info(this.formatMessage(message, color));
  }

  error(message: string, color?: Color) {
    this.logger.error(this.formatMessage(message, color));
  }

  warn(message: string, color?: Color) {
    this.logger.warn(this.formatMessage(message, color));
  }

  debug(message: string, color: Color = 'blue') {
    this.logger.debug(this.formatMessage(message, color));
  }

  private formatMessage(message: string, color: Color = 'magenta') {
    return `${colors[color]}${this.prefix}${message}\x1b[0m`;
  }
}

const colors = {
  magenta: '\x1b[45m', // magenta
  yellow: '\x1b[43m', // yellow
  blue: '\x1b[44m', // blue
};
type Color = keyof typeof colors;

export const logger = new Logger();
