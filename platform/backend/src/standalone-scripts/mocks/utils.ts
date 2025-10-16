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
