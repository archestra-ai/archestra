import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const hostingRequire = createRequire(
  import.meta.resolve("@microsoft/agents-hosting"),
);

// Isolate uncaught errors in the dependency so they cannot crash Vitest.
function runScenario(source: string, modulePath: string, output: string) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "-e", source, modulePath],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(output);
}

// CVE-2026-109869: rejection must not leave an orphaned response stream.
const earlyCloseScenario = String.raw`
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { Client, fetch } = require(process.argv[1]);
(async()=>{
 const server=net.createServer((socket)=>socket.once('data',()=>socket.end(
  'HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n'
 )));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:' + server.address().port;
 const client=new Client(url);
 await assert.rejects(fetch(url,{dispatcher:client}),(error)=>error.cause?.message.includes('content-encoding'));
 await new Promise(resolve=>setTimeout(resolve,200));
 await client.close();
 await new Promise(resolve=>server.close(resolve));
 process.stdout.write('rejected response without process crash');
})().catch(error=>{console.error(error);process.exitCode=1});
`;

test("fetch survives an early close after excessive response content encodings", () => {
  runScenario(
    earlyCloseScenario,
    fileURLToPath(import.meta.resolve("undici")),
    "rejected response without process crash",
  );
});

// CVE-2026-109461: untrusted response routing metadata must not change the
// configured authority. The network boundary returns synthetic token data;
// no external identity service is contacted. Exercise both authorization-code
// and application-token acquisition used by the Teams hosting SDK.
const authScenario = `
const assert = require('node:assert/strict');
const { ConfidentialClientApplication } = require(process.argv[1]);
const tenant = '11111111-1111-1111-1111-111111111111';
const authority = 'https://login.microsoftonline.com/' + tenant;
const posts = [];
const gets = [];
const metadata = (host) => ({
 issuer: 'https://' + host + '/' + tenant + '/v2.0',
 authorization_endpoint: 'https://' + host + '/' + tenant + '/oauth2/v2.0/authorize',
 token_endpoint: 'https://' + host + '/' + tenant + '/oauth2/v2.0/token',
 end_session_endpoint: 'https://' + host + '/' + tenant + '/oauth2/v2.0/logout',
 jwks_uri: 'https://' + host + '/' + tenant + '/discovery/v2.0/keys',
});
const config = {
 auth: {
  clientId: '22222222-2222-2222-2222-222222222222',
  clientSecret: 'local-test-secret', authority,
  authorityMetadata: JSON.stringify(metadata('login.microsoftonline.com')),
  cloudDiscoveryMetadata: JSON.stringify({
   tenant_discovery_endpoint: authority + '/v2.0/.well-known/openid-configuration',
   metadata: [{preferred_network:'login.microsoftonline.com',preferred_cache:'login.microsoftonline.com',aliases:['login.microsoftonline.com']}],
  }),
 },
 system: { networkClient: {
  async sendGetRequestAsync(url) {
   gets.push(url);
   return {status:200,headers:{},body:metadata(new URL(url).hostname)};
  },
  async sendPostRequestAsync(url, options) {
   posts.push({url,body:options.body});
   return {status:200,headers:{},body:{token_type:'Bearer',access_token:'local-access-token',expires_in:3600,scope:'https://graph.microsoft.com/.default'}};
  },
 }},
};
(async()=>{
 const cca = new ConfidentialClientApplication(config);
 const result = await cca.acquireTokenByCode({
  scopes:['https://graph.microsoft.com/.default'],redirectUri:'https://app.invalid/callback',code:'request-code',state:'expected-state',
 }, {code:'payload-code',state:'expected-state',cloud_instance_host_name:'attacker.invalid'});
 assert.equal(result.accessToken,'local-access-token');
 assert.equal(posts.length,1);
 assert.equal(new URL(posts[0].url).hostname,'login.microsoftonline.com',JSON.stringify({posts,gets}));
 assert.equal(new URLSearchParams(posts[0].body).get('code'),'request-code');
 await assert.rejects(cca.acquireTokenByCode({scopes:['https://graph.microsoft.com/.default'],redirectUri:'https://app.invalid/callback',code:'request-code',state:'expected-state'}, {code:'payload-code',state:'wrong-state'}), (error)=>error.errorCode==='state_mismatch');
 posts.length=0;
 const appToken=await new ConfidentialClientApplication(config).acquireTokenByClientCredential({scopes:['https://graph.microsoft.com/.default']});
 assert.equal(appToken.accessToken,'local-access-token');
 assert.equal(new URL(posts[0].url).hostname,'login.microsoftonline.com');
 assert.equal(new URLSearchParams(posts[0].body).get('grant_type'),'client_credentials');
 process.stdout.write('trusted authority and application token preserved');
})().catch((error)=>{console.error(error);process.exitCode=1});
`;

test("Teams MSAL client preserves its authority, state validation and application tokens", () => {
  runScenario(
    authScenario,
    hostingRequire.resolve("@azure/msal-node"),
    "trusted authority and application token preserved",
  );
});
