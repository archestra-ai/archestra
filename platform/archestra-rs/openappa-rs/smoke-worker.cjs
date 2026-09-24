// A separate backend process, used to test PostgreSQL coordination and restart.
const native = require('./index.cjs');
const { databaseUrl } = require('./test-database.cjs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    await native.initializeOpenappa(databaseUrl, 2);
    const policy = { content: require("node:fs").readFileSync(process.env.OPENAPPA_TEST_POLICY_PATH, "utf8"), credentials: {} };
    const request = JSON.parse(input);
    process.stdout.write(request.operation === 'by_offer'
      ? await native.executeRemedyByOffer(JSON.stringify(request.input), policy)
      : await native.dispatchHook(input, policy));
  } catch (error) {
    process.stderr.write(error.message);
    process.exitCode = 1;
  }
});
