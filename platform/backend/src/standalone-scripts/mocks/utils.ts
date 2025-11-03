/**
 * Get a random element from an array
 */
export const randomElement = <T>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)];

/**
 * Generate a random integer between min and max (inclusive)
 */
export const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Generate a random boolean with a given probability
 * @param probability - Value between 0 and 1, defaults to 0.5
 */
export const randomBool = (probability = 0.5): boolean =>
  Math.random() < probability;

/**
 * Generate a random date between start and end dates
 * @param start - Start date (defaults to 6 months ago)
 * @param end - End date (defaults to now)
 */
export const randomDate = (start?: Date, end?: Date): Date => {
  const startDate = start ?? new Date(Date.now() - 180 * 24 * 60 * 60 * 1000); // 6 months ago
  const endDate = end ?? new Date();
  const startTime = startDate.getTime();
  const endTime = endDate.getTime();
  return new Date(startTime + Math.random() * (endTime - startTime));
};
