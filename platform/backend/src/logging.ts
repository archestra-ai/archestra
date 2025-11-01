import pino from "pino";
import config from "@/config";

const logger = pino({
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "HH:MM:ss Z",
      ignore: "pid,hostname",
      singleLine: true,
    },
  },
  level: config.logging.level,
});

export default logger;
