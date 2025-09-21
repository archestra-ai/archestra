import log from 'electron-log/main';
import path from 'path';

import config from '@backend/config';
import { LOGS_DIRECTORY } from '@backend/utils/paths';

const logLevel = config.logLevel as typeof log.transports.file.level;

log.transports.file.level = logLevel;
log.transports.console.level = logLevel;

// Always write to the logs directory, regardless of debug mode
log.transports.file.resolvePathFn = () => path.join(LOGS_DIRECTORY, 'main.log');

// log.transports.console.format = '{level} [{time}] {text}';
// log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

export default log;
