import pino from "pino";

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
  level: process.env.ARCHESTRA_LOGGING_LEVEL?.toLowerCase() || "info",
});

export default logger;
