#include <execinfo.h>
#include <node_api.h>
#include <signal.h>
#include <unistd.h>

/* Diagnostic branch only. Capture stack addresses, never memory or locals. */
static void trace_abort(int signal_number) {
  void *frames[64];
  static const char message[] = "PR9774 native abort stack:\n";
  (void)write(STDERR_FILENO, message, sizeof(message) - 1);
  int count = backtrace(frames, 64);
  backtrace_symbols_fd(frames, count, STDERR_FILENO);
  _exit(128 + signal_number);
}

NAPI_MODULE_INIT() {
  (void)env;
  /* Load the unwinder before a failure, outside the signal handler. */
  void *frames[64];
  (void)backtrace(frames, 64);
  struct sigaction action = {0};
  action.sa_handler = trace_abort;
  action.sa_flags = SA_RESETHAND;
  sigemptyset(&action.sa_mask);
  (void)sigaction(SIGABRT, &action, 0);
  return exports;
}
