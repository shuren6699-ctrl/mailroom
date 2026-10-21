import test from "node:test";
import assert from "node:assert/strict";

import { ACCESS_LOGOUT_PATH, accessLogoutUrl, logoutFromAccess } from "../src/web/logout.ts";

test("builds a same-origin Cloudflare Access logout URL", () => {
  assert.equal(ACCESS_LOGOUT_PATH, "/cdn-cgi/access/logout?returnTo=/");
  assert.equal(
    accessLogoutUrl("https://mail.ads9527.com"),
    "https://mail.ads9527.com/cdn-cgi/access/logout?returnTo=/",
  );
});

test("normalizes an origin with a trailing slash", () => {
  assert.equal(
    accessLogoutUrl("https://mail.ads9527.com/"),
    "https://mail.ads9527.com/cdn-cgi/access/logout?returnTo=/",
  );
});

test("redirects to the Access logout endpoint", () => {
  const redirects = [];
  logoutFromAccess({ assign: (url) => redirects.push(url) });
  assert.deepEqual(redirects, [ACCESS_LOGOUT_PATH]);
});
