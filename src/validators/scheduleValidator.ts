import cronParser from 'cron-parser';

export const validateCronExpression = (cron: string): boolean => {
  try {
    cronParser.parseExpression(cron);
    return true;
  } catch (err) {
    return false;
  }
};

export const calculateNextRun = (cron: string, timezone: string = 'UTC', fromDate: Date = new Date()): Date => {
  const options = {
    currentDate: fromDate,
    tz: timezone,
  };
  const interval = cronParser.parseExpression(cron, options);
  return interval.next().toDate();
};

export const isValidTimezone = (timezone: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
};