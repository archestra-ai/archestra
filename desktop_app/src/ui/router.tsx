import { createHashHistory, createRouter } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

/**
 * Use hash-based routing for Electron to work with file:// protocol
 *
 * See https://github.com/TanStack/router/discussions/835 for more information
 */
const hashHistory = createHashHistory();

export const router = createRouter({
  routeTree,
  history: hashHistory,
});
