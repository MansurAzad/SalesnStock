import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { del as idbDel } from "idb-keyval";
import { supabase } from "@/integrations/supabase/client";
import { useMe, roleLabel, useSettings } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import {
  LayoutDashboard,
  Boxes,
  ArrowLeftRight,
  ShoppingCart,
  Receipt,
  Users,
  CalendarClock,
  Wallet,
  Store,
  ShieldCheck,
  LogOut,
  Menu,
  X,
  Landmark,
  IdCard,
  Barcode,
  Settings,
  FileBarChart,
  Sparkles,
  PackagePlus,
  ReceiptText,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { logoSrc } from "@/lib/brand";
import { syncNow, useOnline, useOutbox, clearOutbox } from "@/lib/offline";
import { toast } from "sonner";
import { CloudOff, RefreshCw, Cloud } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // getSession reads the saved login on this device, so the app still opens offline.
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/auth" });
  },
  component: Layout,
});

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/pos", label: "POS", icon: ShoppingCart },
  { to: "/inventory", label: "Inventory", icon: Boxes },
  { to: "/purchases", label: "Purchases", icon: PackagePlus },
  { to: "/transfers", label: "Transfers", icon: ArrowLeftRight },
  { to: "/sales", label: "Sales", icon: Receipt },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/installments", label: "Installments", icon: CalendarClock },
  { to: "/accounts", label: "Accounts", icon: Wallet },
  { to: "/expenses", label: "Expenses", icon: ReceiptText },
  { to: "/finance", label: "Finance", icon: Landmark },
  { to: "/employees", label: "Employees", icon: IdCard },
  { to: "/labels", label: "Labels", icon: Barcode },
  { to: "/reports", label: "Reports", icon: FileBarChart },
  { to: "/insights", label: "AI insights", icon: Sparkles },
  { to: "/branches", label: "Branches", icon: Store, hq: true },
  { to: "/users", label: "Users", icon: ShieldCheck, hq: true },
  { to: "/sync", label: "Offline sync", icon: RefreshCw },
  { to: "/audit", label: "Audit log", icon: History, hq: true },
  { to: "/settings", label: "Settings", icon: Settings, hq: true },
] as const;

function Layout() {
  const { data: me, isLoading } = useMe();
  const { t, lang, setLang } = useT();
  const { data: settings } = useSettings();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    // The query cache is persisted to IndexedDB — drop it too, otherwise the
    // next user on this device could see the previous user's data.
    try {
      await idbDel("erp-query-cache");
    } catch {
      /* nothing persisted */
    }
    // Queued offline entries belong to the user who made them; drop them too.
    try {
      await clearOutbox();
    } catch {
      /* nothing queued */
    }
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  const noAccess = me && me.roles.length === 0;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const bottom = [nav[0], nav[1], nav[2]];
  const online = useOnline();
  const box = useOutbox();
  useEffect(() => {
    if (!online) return;
    const run = async () => {
      const r = await syncNow();
      if (r.applied) {
        toast.success(`${r.applied} offline entries synced`);
        qc.invalidateQueries();
      }
      if (r.conflicts)
        toast.error(`${r.conflicts} offline entries could not be applied — see Offline sync`);
    };
    void run();
    const id = setInterval(run, 60000);
    return () => clearInterval(id);
  }, [online, box.pending, qc]);

  return (
    <div className="flex min-h-[100dvh]">
      {open && (
        <div
          className="fixed inset-0 z-40 bg-foreground/50 md:hidden print:hidden"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={`print:hidden fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-transform duration-200 md:sticky md:top-0 md:w-60 md:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 px-5 py-5 font-display font-semibold">
          <img
            src={logoSrc(settings?.logo_url)}
            alt="Logo"
            className="h-8 w-8 rounded-md bg-card object-contain p-0.5"
          />{" "}
          <span className="flex-1 truncate">{settings?.company_name ?? "Dealer ERP"}</span>
          <button className="md:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
          {nav
            .filter((n) => !("hq" in n) || me?.isHq)
            .map((n) => {
              const active = path.startsWith(n.to);
              return (
                <Link
                  key={n.to}
                  to={n.to}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground font-semibold"
                      : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }`}
                >
                  <n.icon className="h-4 w-4" /> {t(n.label)}
                </Link>
              );
            })}
        </nav>
        <div className="space-y-3 border-t border-sidebar-border p-4 text-xs">
          <div className="flex rounded-md bg-sidebar-accent p-0.5">
            {(["en", "bn"] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                aria-label={l === "en" ? "Switch to English" : "Switch to Bangla"}
                className={`flex-1 rounded py-1 ${lang === l ? "bg-sidebar-primary text-sidebar-primary-foreground" : ""}`}
              >
                {l === "en" ? "English" : "বাংলা"}
              </button>
            ))}
          </div>
          <div>
            <div className="truncate font-medium text-sidebar-accent-foreground">
              {me?.full_name ?? me?.email}
            </div>
            <div className="opacity-60">
              {me?.roles.map((r) => roleLabel[r]).join(", ") || "No role"}
            </div>
          </div>
          <button
            onClick={signOut}
            className="flex items-center gap-2 opacity-80 hover:opacity-100"
          >
            <LogOut className="h-3.5 w-3.5" /> {t("Sign out")}
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-3 pb-24 sm:p-5 sm:pb-24 md:p-8 print:p-0">
        {(!online || box.pending > 0 || box.conflicts > 0) && (
          <Link
            to="/sync"
            className={`print:hidden mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${online ? "border-accent bg-accent/15" : "border-warning bg-warning/15"}`}
          >
            {online ? (
              <Cloud className="h-4 w-4 shrink-0" />
            ) : (
              <CloudOff className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1">
              {online
                ? t("Online")
                : t("Offline — sales, kisti and expenses are saved on this device")}
              {box.pending > 0 && ` · ${box.pending} ${t("waiting to sync")}`}
              {box.conflicts > 0 && ` · ${box.conflicts} ${t("need attention")}`}
            </span>
          </Link>
        )}
        {isLoading ? null : noAccess ? (
          <div className="mx-auto mt-24 max-w-md rounded-xl border bg-card p-8 text-center">
            <h2 className="text-xl font-semibold">Waiting for access</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your account is created. Ask the Super Admin to assign you a role and branch.
            </p>
            <Button variant="outline" className="mt-4" onClick={signOut}>
              {t("Sign out")}
            </Button>
          </div>
        ) : (
          <Outlet />
        )}
      </main>
      <nav className="print:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
        {bottom.map((n) => {
          const active = path.startsWith(n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${active ? "font-semibold text-primary" : "text-muted-foreground"}`}
            >
              <n.icon className="h-5 w-5" /> {t(n.label)}
            </Link>
          );
        })}
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label="Menu"
          className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${open ? "font-semibold text-primary" : "text-muted-foreground"}`}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />} {t("Menu")}
        </button>
      </nav>
    </div>
  );
}
