// A separate backend process, used to test PostgreSQL coordination and restart.
// It answers exactly one request and then exits: the answer is flushed through
// the pipe before exit, so a kept-alive native handle (a pool connection or a
// runtime thread) cannot hold the worker open after its dispatch returned.
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
// If the parent is gone the pipe breaks and a write callback may never run.
process.stdout.on('error', () => process.exit(1));
process.stderr.on('error', () => process.exit(1));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const policy = { content: require("node:fs").readFileSync(process.env.OPENAPPA_TEST_POLICY_PATH, "utf8"), credentials: {} };
    const request = JSON.parse(input);
    const output = request.operation === 'by_offer'
      ? await native.executeRemedyByOffer(JSON.stringify(request.input), policy)
      : await native.dispatchHook(input, policy);
    process.stdout.write(output, () => process.exit(0));
  } catch (error) {
    process.stderr.write(error?.stack ?? error?.message ?? String(error), () => process.exit(1));
  }
});
