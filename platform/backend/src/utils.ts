export function isProdEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isDevEnv(): boolean {
  return process.env.NODE_ENV === "development";
}

export function isProdAndDbUrlSet(): boolean {
  return isProdEnv() && process.env.DATABASE_URL !== undefined;
}
