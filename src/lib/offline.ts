import { useEffect, useState, useSyncExternalStore } from "react";
import { get, set } from "idb-keyval";
import { supabase } from "@/integrations/supabase/client";

/**
 * Offline outbox: sales, kisti collections and expenses made without internet are
 * stored on this device and sent to the server (apply_offline_op) when online.
 * The server applies each op once (client_ref) and records clashes as "conflict"
 * — first sync wins.
 *
 * Every entry carries the id of the user who made it, so a shared showroom device
 * never books one cashier's sale under another cashier's name, and signing out
 * cannot throw away a sale that has not synced yet.
 */
export type OpKind = "sale" | "kisti" | "expense";
export type OutboxOp = {
  client_ref: string;
  kind: OpKind;
  payload: Record<string, unknown>;
  queued_at: string;
  label: string;
  state: "pending" | "conflict";
  /** The user who made the entry; entries without one predate this field. */
  user_id?: string | undefined;
  error?: string | undefined;
};

const KEY = "erp-outbox";
let ops: OutboxOp[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
let syncing = false;
// The snapshot must change identity whenever anything the UI shows changes —
// including the syncing flag, which used to live in a plain variable and so
// never triggered a re-render.
let snapshot: { ops: OutboxOp[]; syncing: boolean } = { ops, syncing };
const subs = new Set<() => void>();
const emit = () => {
  snapshot = { ops, syncing };
  subs.forEach((f) => f());
};

/** crypto.randomUUID() only exists in a secure context; showrooms on plain http need a fallback. */
function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
    b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 14)}`;
}

/**
 * The queue is read once per page load. The promise is memoised because two
 * concurrent reads used to race: the slower one could overwrite a sale that was
 * queued in between, and the sale was lost.
 */
function load(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (typeof indexedDB === "undefined") {
      loaded = true;
      return;
    }
    ops = ((await get(KEY)) as OutboxOp[] | undefined) ?? [];
    loaded = true;
    emit();
  })();
  return loadPromise;
}
async function save() {
  await set(KEY, ops);
  emit();
}

export function isNetworkError(e: unknown) {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const m = String((e as { message?: string })?.message ?? e ?? "").toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed")
  );
}

export function deviceName() {
  try {
    if (typeof localStorage === "undefined") return "device";
    let d = localStorage.getItem("erp-device");
    if (!d) {
      d = `${/Windows/.test(navigator.userAgent) ? "PC" : "Device"}-${uuid().slice(0, 6)}`;
      localStorage.setItem("erp-device", d);
    }
    return d;
  } catch {
    // A locked-down browser (private mode, embedded webview) refuses storage;
    // the name is only a label, so a fallback is enough.
    return "device";
  }
}

/** The entries of one user; entries queued before the owner was recorded count as theirs. */
const ownedBy = (op: OutboxOp, userId: string | undefined) =>
  !op.user_id || !userId || op.user_id === userId;

export async function enqueue(
  kind: OpKind,
  payload: Record<string, unknown>,
  label: string,
  userId?: string,
) {
  await load();
  ops = [
    ...ops,
    {
      client_ref: uuid(),
      kind,
      payload,
      label,
      queued_at: new Date().toISOString(),
      state: "pending",
      user_id: userId,
    },
  ];
  await save();
}

export async function dismiss(ref: string) {
  await load();
  ops = ops.filter((o) => o.client_ref !== ref);
  await save();
}

/** Drop the entries of one user — used when a device is handed over. */
export async function clearOutbox(userId?: string) {
  await load();
  ops = userId ? ops.filter((o) => o.user_id !== userId) : [];
  await save();
}

export async function syncNow(): Promise<{ applied: number; conflicts: number }> {
  await load();
  if (syncing || !navigator.onLine) return { applied: 0, conflicts: 0 };
  syncing = true;
  emit();
  let applied = 0,
    conflicts = 0;
  try {
    const { data: s } = await supabase.auth.getSession();
    if (!s.session) return { applied, conflicts };
    const uid = s.session.user.id;
    for (const op of ops.filter((o) => o.state === "pending" && ownedBy(o, uid))) {
      const { data, error } = await supabase.rpc("apply_offline_op", {
        _client_ref: op.client_ref,
        _kind: op.kind,
        _payload: op.payload as never,
        _queued_at: op.queued_at,
        _device: deviceName(),
      });
      if (error) {
        if (isNetworkError(error)) break;
        // 23505 = this client_ref was already applied by another device/session:
        // the server is the source of truth, so drop it instead of reporting a clash.
        if (error.code === "23505" || /duplicate key|already exists/i.test(error.message)) {
          ops = ops.filter((o) => o.client_ref !== op.client_ref);
          applied++;
          await save();
          continue;
        }
        ops = ops.map((o) =>
          o.client_ref === op.client_ref ? { ...o, state: "conflict", error: error.message } : o,
        );
        conflicts++;
      } else if ((data as { status?: string })?.status === "conflict") {
        ops = ops.map((o) =>
          o.client_ref === op.client_ref
            ? { ...o, state: "conflict", error: (data as { error?: string }).error }
            : o,
        );
        conflicts++;
      } else {
        ops = ops.filter((o) => o.client_ref !== op.client_ref);
        applied++;
      }
      await save();
    }
  } finally {
    syncing = false;
    emit();
  }
  return { applied, conflicts };
}

const snap = () => snapshot;
const serverSnapshot = { ops: [] as OutboxOp[], syncing: false };
export function useOutbox(userId?: string) {
  useEffect(() => {
    void load();
  }, []);
  const state = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    snap,
    () => serverSnapshot,
  );
  const list = state.ops.filter((o) => ownedBy(o, userId));
  return {
    ops: list,
    pending: list.filter((o) => o.state === "pending").length,
    conflicts: list.filter((o) => o.state === "conflict").length,
    syncing: state.syncing,
  };
}

export function useOnline() {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const f = () => setOn(navigator.onLine);
    f();
    window.addEventListener("online", f);
    window.addEventListener("offline", f);
    return () => {
      window.removeEventListener("online", f);
      window.removeEventListener("offline", f);
    };
  }, []);
  return on;
}

/** Item ids sold offline on this device — hide them from the local stock view. */
export function offlineSoldIds(list: OutboxOp[]) {
  return new Set(
    list
      .filter((o) => o.kind === "sale" && o.state === "pending")
      .flatMap((o) => ((o.payload["items"] as { item_id: string }[]) ?? []).map((i) => i.item_id)),
  );
}
