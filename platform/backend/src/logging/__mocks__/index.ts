/**
 * Jest-style mock for `@/logging`, activated per test file by a bare
 * `vi.mock("@/logging");`. Delegates to the canonical factory so the mock
 * surface lives in one place.
 */
import { loggingModuleMock } from "@/test/mocks/logging";

const mock = loggingModuleMock();
export default mock.default;
