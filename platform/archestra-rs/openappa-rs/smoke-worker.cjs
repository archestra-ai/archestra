// A separate backend process, used to test PostgreSQL coordination and restart.
const native = require('./index.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    await native.initializeOpenappa(process.env.OPENAPPA_TEST_DATABASE_URL, process.env.OPENAPPA_TEST_POLICY_PATH);
    process.stdout.write(await native.dispatchHook(input));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
});
