import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_LOGO } from "@/lib/brand";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — Mobile Dealer ERP" },
      {
        name: "description",
        content: "Sign in to manage branches, stock, sales and installments.",
      },
      { property: "og:title", content: "Sign in — Mobile Dealer ERP" },
      {
        property: "og:description",
        content: "Sign in to manage branches, stock, sales and installments.",
      },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"in" | "up" | "reset" | "sent">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("reset") === "1") setMode("reset");
  }, []);

  async function requestPasswordReset() {
    if (!email) {
      toast.error("Enter your account email first");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth?reset=1`,
      });
      if (error) throw error;
      setMode("sent");
      toast.success("Password reset link sent");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        nav({ to: "/dashboard" });
      } else if (mode === "up") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin, data: { full_name: name } },
        });
        if (error) throw error;
        toast.success("Account created. Check your email to confirm, then sign in.");
        setMode("in");
      } else if (mode === "reset") {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        toast.success("Password updated");
        nav({ to: "/dashboard" });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2 font-display text-lg font-semibold">
          <img src={DEFAULT_LOGO} alt="Logo" className="h-10 w-10 rounded-md bg-card p-0.5" />{" "}
          Mobile Dealer ERP
        </div>
        <div>
          <h1 className="text-4xl font-semibold leading-tight text-sidebar-accent-foreground">
            Every IMEI, every showroom,
            <br />
            <span className="text-sidebar-primary">one ledger.</span>
          </h1>
          <p className="mt-4 max-w-md text-sidebar-foreground/70">
            Stock, transfers, POS, kisti and accounts for the dealer house and all brand showrooms.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/50">৳ BDT · Bangladesh</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm space-y-4">
          <img src={DEFAULT_LOGO} alt="Logo" className="mx-auto h-24 w-24 object-contain" />
          <h2 className="text-center text-2xl font-semibold">
            {
              {
                in: "Sign in",
                up: "Create account",
                reset: "Choose a new password",
                sent: "Check your email",
              }[mode]
            }
          </h2>
          {mode === "sent" && (
            <p className="text-center text-sm text-muted-foreground">
              If an account exists for {email}, a password reset link is on its way.
            </p>
          )}
          {mode === "up" && (
            <div className="space-y-1.5">
              <Label>Full name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          {mode !== "sent" && (
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={mode === "reset"}
              />
            </div>
          )}
          {mode !== "sent" && mode !== "reset" && (
            <div className="space-y-1.5">
              <Label>Password</Label>
              <Input
                type="password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}
          {mode === "reset" && (
            <div className="space-y-1.5">
              <Label>New password</Label>
              <Input
                type="password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          )}
          {mode !== "sent" && (
            <Button className="w-full" disabled={busy}>
              {mode === "in" ? "Sign in" : mode === "up" ? "Sign up" : "Update password"}
            </Button>
          )}
          {mode === "in" && (
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={requestPasswordReset}
            >
              Forgot password?
            </button>
          )}
          {(mode === "reset" || mode === "sent") && (
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground"
              onClick={() => {
                setPassword("");
                setMode("in");
              }}
            >
              Back to sign in
            </button>
          )}
          {(mode === "in" || mode === "up") && (
            <button
              type="button"
              className="w-full text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setMode(mode === "in" ? "up" : "in")}
            >
              {mode === "in" ? "New staff member? Create an account" : "Have an account? Sign in"}
            </button>
          )}
          {(mode === "in" || mode === "up") && (
            <p className="text-xs text-muted-foreground">
              The first account becomes Super Admin. Others get access after an admin assigns a role
              and branch.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
