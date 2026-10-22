import test from "node:test";
import assert from "node:assert/strict";

import { ACCESS_LOGOUT_PATH, accessLogoutUrl, logoutFromAccess } from "../src/web/logout.ts";

test("builds a same-origin Cloudflare Access logout URL", () => {
  assert.equal(ACCESS_LOGOUT_PATH, "/cdn-cgi/access/logout");
  assert.equal(
    accessLogoutUrl("https://mail.ads9527.com"),
    "https://mail.ads9527.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fmail.ads9527.com%2F",
  );
});

test("normalizes an origin with a trailing slash", () => {
  assert.equal(
    accessLogoutUrl("https://mail.ads9527.com/"),
    "https://mail.ads9527.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fmail.ads9527.com%2F",
  );
});

test("redirects to the Access logout endpoint", () => {
  const redirects = [];
  logoutFromAccess({
    origin: "https://mail.ads9527.com",
    assign: (url) => redirects.push(url),
  });
  assert.deepEqual(redirects, [
    "https://mail.ads9527.com/cdn-cgi/access/logout?returnTo=https%3A%2F%2Fmail.ads9527.com%2F",
  ]);
});
