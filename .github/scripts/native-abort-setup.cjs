// Load after Node initializes its own signal handlers, in each test process.
require(process.env.ARCHESTRA_NATIVE_ABORT_TRACE_ADDON);
