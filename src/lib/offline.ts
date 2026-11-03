import { useEffect, useState, useSyncExternalStore } from "react";
import { get, set } from "idb-keyval";
import { supabase } from "@/integrations/supabase/client";

/**
 * Offline outbox: sales, kisti collections and expenses made without internet are
 * stored on this device and sent to the server (apply_offline_op) when online.
 * The server applies each op once (client_ref) and records clashes as "conflict"
 * — first sync wins.
 */
export type OpKind = "sale" | "kisti" | "expense";
export type OutboxOp = {
  client_ref: string;
  kind: OpKind;
  payload: Record<string, unknown>;
  queued_at: string;
  label: string;
  state: "pending" | "conflict";
  error?: string | undefined;
};

const KEY = "erp-outbox";
let ops: OutboxOp[] = [];
let loaded = false;
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

async function load() {
  if (loaded || typeof indexedDB === "undefined") return;
  ops = ((await get(KEY)) as OutboxOp[] | undefined) ?? [];
  loaded = true;
  emit();
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
  if (typeof localStorage === "undefined") return "device";
  let d = localStorage.getItem("erp-device");
  if (!d) {
    d = `${/Windows/.test(navigator.userAgent) ? "PC" : "Device"}-${uuid().slice(0, 6)}`;
    localStorage.setItem("erp-device", d);
  }
  return d;
}

export async function enqueue(kind: OpKind, payload: Record<string, unknown>, label: string) {
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
    },
  ];
  await save();
}

export async function dismiss(ref: string) {
  await load();
  ops = ops.filter((o) => o.client_ref !== ref);
  await save();
}

/** Drop every queued entry — used on sign-out so the next user on this device
 *  does not inherit the previous user's unsynced sales, kisti or expenses. */
export async function clearOutbox() {
  await load();
  ops = [];
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
    for (const op of ops.filter((o) => o.state === "pending")) {
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
export function useOutbox() {
  useEffect(() => {
    void load();
  }, []);
  const state = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    snap,
    () => ({ ops: [] as OutboxOp[], syncing: false }),
  );
  const list = state.ops;
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
