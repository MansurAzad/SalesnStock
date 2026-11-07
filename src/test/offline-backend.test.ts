import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboxOp } from "@/lib/offline";
import { SUPABASE_PROJECT_ID } from "@/integrations/supabase/config";

const mocks = vi.hoisted(() => ({
  store: new Map<string, OutboxOp[]>(),
  get: vi.fn<(key: string) => Promise<OutboxOp[] | undefined>>(),
  set: vi.fn<(key: string, value: OutboxOp[]) => Promise<void>>(),
  del: vi.fn(),
  clear: vi.fn(),
  getSession: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("idb-keyval", () => ({
  get: mocks.get,
  set: mocks.set,
  del: mocks.del,
  clear: mocks.clear,
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession }, rpc: mocks.rpc },
}));

const PROJECT_KEY = `erp-outbox:${SUPABASE_PROJECT_ID}`;
const LEGACY_KEY = "erp-outbox";
const FOREIGN_KEY = "erp-outbox:pljmmnilzugyznjajciq";
const USER_ID = "cashier-current";
const OTHER_USER_ID = "cashier-other";

function operation(client_ref: string, user_id?: string): OutboxOp {
  return {
    client_ref,
    kind: "expense",
    payload: { amount: 100, category: "transport" },
    queued_at: "2026-01-01T09:00:00.000Z",
    label: client_ref,
    state: "pending",
    ...(user_id ? { user_id } : {}),
  };
}

// Both owned and ownerless legacy entries are ambiguous across backends.
const legacyOps = [operation("legacy-owned", USER_ID), operation("legacy-ownerless")];
const foreignOps = [operation("foreign-project", USER_ID)];

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.store.clear();
  mocks.store.set(LEGACY_KEY, structuredClone(legacyOps));
  mocks.store.set(FOREIGN_KEY, structuredClone(foreignOps));
  // Model IndexedDB's structured copies, so mutations cannot silently change storage.
  mocks.get.mockImplementation(async (key) => structuredClone(mocks.store.get(key)));
  mocks.set.mockImplementation(async (key, value) => {
    mocks.store.set(key, structuredClone(value));
  });
  mocks.del.mockImplementation(async (key: string) => {
    mocks.store.delete(key);
  });
  mocks.clear.mockImplementation(async () => {
    mocks.store.clear();
  });
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: USER_ID } } } });
  mocks.rpc.mockResolvedValue({ data: { status: "applied" }, error: null });
  mocks.fetch.mockRejectedValue(new Error("Unexpected network request"));
  vi.stubGlobal("fetch", mocks.fetch);
  // idb-keyval itself is mocked; this only enables offline.ts's browser storage path.
  vi.stubGlobal("indexedDB", {});
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  localStorage.setItem("erp-device", "regression-device");
});

afterEach(() => {
  localStorage.removeItem("erp-device");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectProjectIsolation() {
  expect(mocks.get).toHaveBeenCalledTimes(1);
  expect(mocks.get).toHaveBeenCalledWith(PROJECT_KEY);
  for (const [key] of mocks.set.mock.calls) expect(key).toBe(PROJECT_KEY);
  expect(mocks.del).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.store.get(LEGACY_KEY)).toEqual(legacyOps);
  expect(mocks.store.get(FOREIGN_KEY)).toEqual(foreignOps);
  expect(mocks.fetch).not.toHaveBeenCalled();
}

describe("backend-scoped offline outbox", () => {
  it("loads and appends only to the canonical project key, retaining existing entries", async () => {
    const existing = operation("existing-project-op", OTHER_USER_ID);
    mocks.store.set(PROJECT_KEY, [existing]);
    const { enqueue } = await import("@/lib/offline");
    const payload = { amount: 250, category: "rent" };

    await enqueue("expense", payload, "New expense", USER_ID);

    expect(PROJECT_KEY).toBe("erp-outbox:fftxkldvtqcgpuryetun");
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(PROJECT_KEY, [
      existing,
      {
        client_ref: expect.any(String),
        kind: "expense",
        payload,
        label: "New expense",
        queued_at: expect.any(String),
        state: "pending",
        user_id: USER_ID,
      },
    ]);
    expect(mocks.store.get(PROJECT_KEY)).toHaveLength(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expectProjectIsolation();
  });

  it("does not migrate or replay legacy entries when the project queue does not exist", async () => {
    const { syncNow } = await import("@/lib/offline");

    await expect(syncNow()).resolves.toEqual({ applied: 0, conflicts: 0 });

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.store.has(PROJECT_KEY)).toBe(false);
    expectProjectIsolation();
  });

  it("starts a new project queue without copying legacy data, then syncs only the new operation", async () => {
    const { enqueue, syncNow } = await import("@/lib/offline");
    const payload = { amount: 50, category: "transport" };
    await enqueue("expense", payload, "New project expense", USER_ID);
    const queued = mocks.store.get(PROJECT_KEY);
    expect(queued).toHaveLength(1);
    const ref = queued![0]!.client_ref;

    await expect(syncNow()).resolves.toEqual({ applied: 1, conflicts: 0 });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith(
      "apply_offline_op",
      expect.objectContaining({ _client_ref: ref, _payload: payload, _actor: USER_ID }),
    );
    expect(mocks.store.get(PROJECT_KEY)).toEqual([]);
    expectProjectIsolation();
  });

  it("replays only the signed-in user's pending project ops and retains other users' ops", async () => {
    const own = operation("current-user-op", USER_ID);
    const other = operation("other-user-op", OTHER_USER_ID);
    const conflict: OutboxOp = {
      ...operation("existing-conflict", USER_ID),
      state: "conflict",
      error: "Already sold",
    };
    mocks.store.set(PROJECT_KEY, [other, own, conflict]);
    const { syncNow } = await import("@/lib/offline");

    await expect(syncNow()).resolves.toEqual({ applied: 1, conflicts: 0 });

    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("apply_offline_op", {
      _client_ref: own.client_ref,
      _kind: own.kind,
      _payload: own.payload,
      _queued_at: own.queued_at,
      _device: "regression-device",
      _actor: USER_ID,
    });
    expect(mocks.store.get(PROJECT_KEY)).toEqual([other, conflict]);
    expect(mocks.set).toHaveBeenCalledTimes(1);

    // A repeat sync under the same account must still leave the other cashier's work alone.
    await expect(syncNow()).resolves.toEqual({ applied: 0, conflicts: 0 });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.store.get(PROJECT_KEY)).toEqual([other, conflict]);
    expectProjectIsolation();
  });

  it("does not replay project operations without a signed-in session", async () => {
    const own = operation("current-user-op", USER_ID);
    mocks.store.set(PROJECT_KEY, [own]);
    mocks.getSession.mockResolvedValue({ data: { session: null } });
    const { syncNow } = await import("@/lib/offline");

    await expect(syncNow()).resolves.toEqual({ applied: 0, conflicts: 0 });

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.store.get(PROJECT_KEY)).toEqual([own]);
    expectProjectIsolation();
  });

  it.each(["dismiss", "clear-user", "clear-all"] as const)(
    "%s changes only the project queue and never deletes legacy data",
    async (action) => {
      const own = operation("current-user-op", USER_ID);
      const other = operation("other-user-op", OTHER_USER_ID);
      mocks.store.set(PROJECT_KEY, [own, other]);
      const { dismiss, clearOutbox } = await import("@/lib/offline");

      if (action === "dismiss") await dismiss(own.client_ref);
      else if (action === "clear-user") await clearOutbox(USER_ID);
      else await clearOutbox();

      expect(mocks.set).toHaveBeenCalledTimes(1);
      expect(mocks.store.get(PROJECT_KEY)).toEqual(action === "clear-all" ? [] : [other]);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expectProjectIsolation();
    },
  );
});
