// Mock database module - actual instance is created in setup-tests.ts
let mockDb: any = null;

export function setMockDb(db: any) {
  mockDb = db;
}

export default new Proxy(
  {},
  {
    get(_target, prop) {
      if (!mockDb) {
        throw new Error(
          "Mock database not initialized. Make sure setup-tests.ts is loaded.",
        );
      }
      return mockDb[prop];
    },
  },
);
