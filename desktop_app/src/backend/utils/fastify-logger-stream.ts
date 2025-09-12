import log from '@backend/utils/logger';

export const electronLogStream = {
  write: (msg: string) => {
    try {
      const obj = JSON.parse(msg);
      const level = obj.level === 30 ? 'info' : obj.level === 40 ? 'warn' : obj.level === 50 ? 'error' : 'debug';

      // Format the log message in a single line
      let formattedMsg = obj.msg || '';

      // Add request info if present
      if (obj.req) {
        formattedMsg = `${obj.req.method} ${obj.req.url} - ${formattedMsg}`;
      }

      // Add response info if present
      if (obj.res?.statusCode) {
        formattedMsg += ` [${obj.res.statusCode}]`;
      }

      // Add response time if present
      if (obj.responseTime) {
        formattedMsg += ` ${obj.responseTime.toFixed(2)}ms`;
      }

      log[level](`[Server]: ${formattedMsg}`);
    } catch (e) {
      // Fallback for non-JSON messages
      log.info(`[Server]: ${msg}`);
    }
  },
};
