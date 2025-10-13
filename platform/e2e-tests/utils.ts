import { Page } from "@playwright/test";

export const BASE_URL = 'http://localhost:3000';

export function goToPage(page: Page, path = '') {
  return page.goto(`${BASE_URL}${path}`);
}

export function getRandomString(length = 10, prefix = '') {
  return `${prefix}-${Math.random().toString(36).substring(2, 2 + length)}`;
}
