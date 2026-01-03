import { expect, test } from "./fixtures";

test.describe
  .serial("User Token API", () => {
    test("should get or create personal token", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });
      const token = await response.json();

      expect(token).toHaveProperty("id");
      expect(token).toHaveProperty("name");
      expect(token).toHaveProperty("tokenStart");
      expect(token).toHaveProperty("createdAt");
      expect(token.tokenStart).toMatch(/^archestra_/);
    });

    test("should get token value", async ({ request, makeApiRequest }) => {
      // First ensure token exists
      await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me/value",
      });
      const tokenValue = await response.json();

      expect(tokenValue).toHaveProperty("value");
      expect(tokenValue.value).toMatch(/^archestra_[a-f0-9]{32}$/);
    });

    test("should rotate personal token", async ({
      request,
      makeApiRequest,
    }) => {
      // First ensure token exists and get its value
      const initialToken = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });
      const initialTokenData = await initialToken.json();

      const initialValueResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me/value",
      });
      const initialValue = (await initialValueResponse.json()).value;

      // Rotate the token
      const rotateResponse = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/user-tokens/me/rotate",
      });
      const rotatedToken = await rotateResponse.json();

      expect(rotatedToken).toHaveProperty("id");
      expect(rotatedToken).toHaveProperty("value");
      expect(rotatedToken.id).toBe(initialTokenData.id);
      expect(rotatedToken.value).toMatch(/^archestra_[a-f0-9]{32}$/);
      expect(rotatedToken.value).not.toBe(initialValue);

      // Verify new value is returned via value endpoint
      const newValueResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me/value",
      });
      const newValue = (await newValueResponse.json()).value;

      expect(newValue).toBe(rotatedToken.value);
    });

    test("should return same token on repeated calls", async ({
      request,
      makeApiRequest,
    }) => {
      const response1 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });
      const token1 = await response1.json();

      const response2 = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });
      const token2 = await response2.json();

      expect(token1.id).toBe(token2.id);
      expect(token1.tokenStart).toBe(token2.tokenStart);
    });

    test("token start should match actual value prefix", async ({
      request,
      makeApiRequest,
    }) => {
      const tokenResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me",
      });
      const token = await tokenResponse.json();

      const valueResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/user-tokens/me/value",
      });
      const tokenValue = await valueResponse.json();

      // tokenStart should be the first 14 characters of the full value
      expect(tokenValue.value.substring(0, 14)).toBe(token.tokenStart);
    });
  });
