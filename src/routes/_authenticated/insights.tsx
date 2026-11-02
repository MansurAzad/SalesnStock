import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { useBranches, useMe } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({ meta: [
    { title: "AI insights — Dealer ERP" },
    { name: "description", content: "Ask questions about sales and stock and get AI trend summaries." },
    { property: "og:title", content: "AI insights — Dealer ERP" },
    { property: "og:description", content: "Ask questions about sales and stock and get AI trend summaries." },
  ] }),
  component: InsightsPage,
});

const examples = [
  "Which models are selling best this month and what should I restock?",
  "Which stock is slow-moving and how can I clear it?",
  "Compare branch performance and suggest transfers.",
  "এই মাসে বিক্রির প্রবণতা কেমন? কী করা উচিত?",
];

function InsightsPage() {
  const { data: me } = useMe();
  const { data: branches = [] } = useBranches();
  const [q, setQ] = useState("");
  const [branch, setBranch] = useState<string>("");
  const [days, setDays] = useState(30);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ctrl = useRef<AbortController | null>(null);
  const branchId = branch || (me?.isHq ? "" : me?.branch_id ?? "");

  async function ask(question = q) {
    if (!question.trim() || busy) return;
    setQ(question); setAnswer(""); setErr(""); setBusy(true);
    const ac = new AbortController(); ctrl.current = ac;
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch("/api/insights", {
        method: "POST", signal: ac.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
        body: JSON.stringify({ question, branchId: branchId || null, days }),
      });
      if (!res.ok || !res.body) { setErr((await res.text()) || "Request failed"); return; }
      const reader = res.body.getReader(); const dec = new TextDecoder(); let got = "";
      for (;;) { const { done, value } = await reader.read(); if (done) break; got += dec.decode(value, { stream: true }); setAnswer(got); }
      if (!got.trim()) setErr("The AI returned no answer. Please check AI credits or try a different question later.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally { setBusy(false); ctrl.current = null; }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="AI insights" />
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2 text-sm">
          {me?.isHq && (
            <select className="rounded-md border bg-background px-2 py-1" value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">All branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
          <select className="rounded-md border bg-background px-2 py-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </div>
        <Textarea rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about your sales and stock…" />
        <div className="flex flex-wrap gap-2">
          {busy ? <Button variant="outline" onClick={() => ctrl.current?.abort()}>Stop</Button>
                : <Button onClick={() => ask()} disabled={!q.trim()}>Ask</Button>}
          {examples.map((x) => <Button key={x} size="sm" variant="ghost" disabled={busy} onClick={() => ask(x)}>{x}</Button>)}
        </div>
      </Card>
      {(busy || answer || err) && (
        <Card className="p-4">
          {err && <p className="text-sm text-destructive">{err}</p>}
          {busy && !answer && <p className="text-sm text-muted-foreground">Analysing your data…</p>}
          {answer && <div className="whitespace-pre-wrap text-sm leading-relaxed">{answer}</div>}
        </Card>
      )}
    </div>
  );
}
