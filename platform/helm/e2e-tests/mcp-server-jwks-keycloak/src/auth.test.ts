import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthContext } from "./auth.js";

test("buildAuthContext preserves demo token claim and raw bearer token", () => {
  const auth = buildAuthContext(
    {
      sub: "user-123",
      iss: "http://localhost:30081/realms/archestra",
      aud: "archestra-oidc",
      email: "admin@example.com",
      name: "Admin User",
      preferred_username: "admin",
      demo_token_value: "admin_user_token",
      realm_roles: ["archestra-admins"],
    },
    "signed.jwt.token",
  );

  assert.equal(auth.sub, "user-123");
  assert.equal(auth.email, "admin@example.com");
  assert.equal(auth.preferredUsername, "admin");
  assert.equal(auth.demoTokenValue, "admin_user_token");
  assert.deepEqual(auth.roles, ["archestra-admins"]);
  assert.equal(auth.rawToken, "signed.jwt.token");
  assert.equal(auth.authorizationHeader, "Bearer signed.jwt.token");
});
