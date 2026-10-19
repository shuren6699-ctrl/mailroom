import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function fixture({ owner = null, failUnsubscribe = false, refuseUnsubscribe = false, privateStorage = false } = {}) {
  const calls = { updates: 0, unsubscribes: 0, closes: 0, permissionPrompts: 0 };
  let savedOwner = owner;
  let subscription;
  const existing = {
    async unsubscribe() {
      calls.unsubscribes++;
      if (failUnsubscribe) throw new Error("Browser unsubscribe unavailable");
      if (refuseUnsubscribe) return false;
      subscription = null;
      return true;
    },
  };
  subscription = existing;
  const registration = {
    async update() { calls.updates++; },
    async getNotifications() { return [{ close() { calls.closes++; } }]; },
    pushManager: { async getSubscription() { return subscription; } },
  };
  const context = vm.createContext({
    window: { PushManager: function () {}, Notification: {} },
    navigator: { serviceWorker: { async getRegistration() { return registration; } } },
    Notification: { permission: "granted", async requestPermission() { calls.permissionPrompts++; return "granted"; } },
    localStorage: {
      getItem() { if (privateStorage) throw new Error("Storage unavailable"); return savedOwner; },
      setItem(_key, value) { if (privateStorage) throw new Error("Storage unavailable"); savedOwner = value; },
    },
    setTimeout, clearTimeout,
  });
  function load(path) {
    const exports = {};
    context.exports = exports;
    context.require = () => load("src/web/ui-messages.ts");
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInContext(`(function (exports, require) { ${compiled}\n})`, context)(exports, context.require);
    return exports;
  }
  const helper = load("src/web/push-notifications.ts");
  return { helper, calls, registration, owner: () => savedOwner, restoreSubscription() { subscription = existing; } };
}

test("browser identity reconciliation rotates legacy endpoints before recording a new owner without permission prompts", async () => {
  const f = fixture();
  await f.helper.reconcileBrowserPushIdentity("  Owner@Example.com ");
  assert.equal(f.calls.updates, 1);
  assert.equal(f.calls.unsubscribes, 1);
  assert.equal(f.calls.closes, 1);
  assert.equal(f.owner(), "owner@example.com");
  assert.equal(f.calls.permissionPrompts, 0);
});

test("browser identity reconciliation deduplicates StrictMode and preserves a subscription for the same owner", async () => {
  const f = fixture({ owner: "owner@example.com" });
  await Promise.all([f.helper.reconcileBrowserPushIdentity("owner@example.com"), f.helper.reconcileBrowserPushIdentity("owner@example.com")]);
  assert.equal(f.calls.updates, 1);
  assert.equal(f.calls.unsubscribes, 0);
  assert.equal(f.calls.closes, 0);
  f.restoreSubscription();
  await f.helper.reconcileBrowserPushIdentity("other@example.com");
  assert.equal(f.calls.unsubscribes, 1);
  assert.equal(f.owner(), "other@example.com");
});

test("browser identity reconciliation does not transfer ownership when unsubscribe fails or is refused", async () => {
  for (const options of [{ failUnsubscribe: true }, { refuseUnsubscribe: true }]) {
    const f = fixture({ owner: "owner@example.com", ...options });
    await assert.rejects(f.helper.reconcileBrowserPushIdentity("other@example.com"));
    assert.equal(f.owner(), "owner@example.com");
    assert.equal(f.calls.permissionPrompts, 0);
  }
});

test("browser identity reconciliation works with unavailable storage and serializes account changes", async () => {
  const f = fixture({ privateStorage: true });
  await Promise.all([f.helper.reconcileBrowserPushIdentity("owner@example.com"), f.helper.reconcileBrowserPushIdentity("owner@example.com")]);
  assert.equal(f.calls.unsubscribes, 1);
  f.restoreSubscription();
  await Promise.all([f.helper.reconcileBrowserPushIdentity("other@example.com"), f.helper.reconcileBrowserPushIdentity("owner@example.com")]);
  assert.equal(f.calls.unsubscribes, 2);
  assert.equal(f.calls.permissionPrompts, 0);
});

test("browser identity reconciliation waits for the security worker to activate before reusing endpoints", async () => {
  const f = fixture({ owner: "owner@example.com" });
  let onStateChange;
  const worker = {
    state: "installing",
    addEventListener(_event, listener) { onStateChange = listener; },
    removeEventListener() {},
  };
  f.registration.installing = worker;
  let complete = false;
  const reconcile = f.helper.reconcileBrowserPushIdentity("owner@example.com").then(() => { complete = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(complete, false);
  worker.state = "activated";
  onStateChange();
  await reconcile;
  assert.equal(complete, true);
  assert.equal(f.calls.unsubscribes, 0);
});

test("a failed service worker security update keeps ownership unchanged and permits a later retry", async () => {
  const f = fixture({ owner: "owner@example.com" });
  f.registration.update = async () => { throw new Error("Update unavailable"); };
  await assert.rejects(f.helper.reconcileBrowserPushIdentity("other@example.com"));
  assert.equal(f.owner(), "owner@example.com");
  f.registration.update = async () => {};
  await f.helper.reconcileBrowserPushIdentity("other@example.com");
  assert.equal(f.owner(), "other@example.com");
  assert.equal(f.calls.unsubscribes, 1);
});
