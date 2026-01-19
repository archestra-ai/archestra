import { isAuthenticated } from "./auth.utils";

export function useIsAuthenticated() {
  return isAuthenticated();
}
