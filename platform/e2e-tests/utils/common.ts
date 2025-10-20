import { Page } from '@playwright/test';
import { BASE_URL } from '../consts';

export function goToPage(page: Page, path = '') {
  return page.goto(`${BASE_URL}${path}`);
}

export function getRandomString(length = 10, prefix = '') {
  return `${prefix}-${Math.random()
    .toString(36)
    .substring(2, 2 + length)}`;
}
