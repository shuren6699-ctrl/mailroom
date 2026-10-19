import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceQueryClient } from "../src/web/workspace-query-client.ts";

test("a late mutation callback cannot populate another identity's workspace cache", async () => {
  const oldClient = createWorkspaceQueryClient();
  const memberClient = createWorkspaceQueryClient();
  try {
    oldClient.setQueryData(["mailboxes"], [{ id: 1, address: "private-admin@example.com" }]);
    const assignedMailboxes = [{ id: 2, address: "assigned-member@example.com" }];
    memberClient.setQueryData(["mailboxes"], assignedMailboxes);

    let completeMutation;
    let callbackRan = false;
    let signalMutationStarted;
    const mutationStarted = new Promise((resolveStarted) => {
      signalMutationStarted = resolveStarted;
    });
    const delayedMutation = oldClient.getMutationCache().build(oldClient, {
      mutationFn: () => new Promise((resolve) => {
        completeMutation = resolve;
        signalMutationStarted();
      }),
      onSuccess: () => {
        callbackRan = true;
        oldClient.setQueryData(["mailboxes"], [{ id: 1, address: "late-admin-secret@example.com" }]);
        oldClient.setQueryData(["thread", 1], { body: "admin private thread" });
      },
    });
    // Cache clearing alone does not suppress an in-flight mutation's callbacks.
    const pendingMutation = delayedMutation.execute();
    await mutationStarted;
    await oldClient.cancelQueries();
    oldClient.clear();
    completeMutation({ ok: true });
    await pendingMutation;

    assert.equal(callbackRan, true);
    assert.equal(oldClient.getQueryData(["mailboxes"])[0].address, "late-admin-secret@example.com");
    assert.deepEqual(memberClient.getQueryData(["mailboxes"]), assignedMailboxes);
    assert.equal(memberClient.getQueryData(["thread", 1]), undefined);
  } finally {
    oldClient.clear();
    memberClient.clear();
  }
});

test("each identity or grant change starts with an empty workspace and the normal polling defaults", () => {
  const previousClient = createWorkspaceQueryClient();
  const changedGrantsClient = createWorkspaceQueryClient();
  try {
    previousClient.setQueryData(["mailboxes"], [{ id: 1 }]);
    assert.notEqual(previousClient, changedGrantsClient);
    assert.equal(changedGrantsClient.getQueryData(["mailboxes"]), undefined);
    assert.equal(changedGrantsClient.getDefaultOptions().queries.staleTime, 10_000);
    assert.equal(changedGrantsClient.getDefaultOptions().queries.refetchInterval, 30_000);
  } finally {
    previousClient.clear();
    changedGrantsClient.clear();
  }
});
