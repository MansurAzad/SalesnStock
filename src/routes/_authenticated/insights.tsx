import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { useBranches, useMe } from "@/lib/erp";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/insights")({
  head: () => ({
    meta: [
      { title: "AI insights — Dealer ERP" },
      {
        name: "description",
        content: "Ask questions about sales and stock and get AI trend summaries.",
      },
      { property: "og:title", content: "AI insights — Dealer ERP" },
      {
        property: "og:description",
        content: "Ask questions about sales and stock and get AI trend summaries.",
      },
    ],
  }),
  component: InsightsPage,
});

const examples = [
  "Which models are selling best this month and what should I restock?",
  "Which stock is slow-moving and how can I clear it?",
  "Compare branch performance and suggest transfers.",
  "How much cash do we have and where did the money go this month?",
  "Who has overdue kisti and how much should we chase?",
  "What did we spend on expenses this month and which category grew?",
  "How much do we owe suppliers and what did we buy?",
  "এই মাসে বিক্রির প্রবণতা কেমন? কী করা উচিত?",
];

/** Renders the small markdown subset the model is asked to use (headings,
 *  bullets, numbered lists, bold/italic/code) without injecting HTML. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={`${key}-b${n++}`}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={`${key}-c${n++}`}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={`${key}-i${n++}`}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push(
        <p key={blocks.length} className="mt-3 font-semibold">
          {inline(heading[2] ?? "", `h${blocks.length}`)}
        </p>,
      );
      i++;
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      const ordered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const l = (lines[i] ?? "").trim();
        const mu = /^[-*•]\s+(.*)$/.exec(l);
        const mo = /^\d+[.)]\s+(.*)$/.exec(l);
        const hit = ordered ? mo : mu;
        if (!hit) break;
        items.push(hit[1] ?? "");
        i++;
      }
      const tag = `${ordered ? "ol" : "ul"}${blocks.length}`;
      const children = items.map((it, k) => <li key={k}>{inline(it, `${tag}-${k}`)}</li>);
      blocks.push(
        ordered ? (
          <ol key={blocks.length} className="ml-5 list-decimal space-y-0.5">
            {children}
          </ol>
        ) : (
          <ul key={blocks.length} className="ml-5 list-disc space-y-0.5">
            {children}
          </ul>
        ),
      );
      continue;
    }
    blocks.push(
      <p key={blocks.length} className="whitespace-pre-wrap">
        {inline(trimmed, `p${blocks.length}`)}
      </p>,
    );
    i++;
  }
  return <div className="space-y-1">{blocks}</div>;
}

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
  const branchId = branch || (me?.isHq ? "" : (me?.branch_id ?? ""));

  async function ask(question = q) {
    if (!question.trim() || busy) return;
    setQ(question);
    setAnswer("");
    setErr("");
    setBusy(true);
    const ac = new AbortController();
    ctrl.current = ac;
    try {
      const { data: s } = await supabase.auth.getSession();
      const res = await fetch("/api/insights", {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ question, branchId: branchId || null, days }),
      });
      if (!res.ok || !res.body) {
        setErr((await res.text()) || "Request failed");
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let got = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += dec.decode(value, { stream: true });
        setAnswer(got);
      }
      if (!got.trim())
        setErr(
          "The AI returned no answer. Please check AI credits or try a different question later.",
        );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
    } finally {
      setBusy(false);
      ctrl.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="AI insights" />
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap gap-2 text-sm">
          {me?.isHq && (
            <select
              className="rounded-md border bg-background px-2 py-1"
              aria-label="Branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <select
            className="rounded-md border bg-background px-2 py-1"
            aria-label="Period"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
        <Textarea
          rows={3}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about sales, stock, cash, kisti dues, expenses or purchases…"
        />
        <div className="flex flex-wrap gap-2">
          {busy ? (
            <Button variant="outline" onClick={() => ctrl.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button onClick={() => ask()} disabled={!q.trim()}>
              Ask
            </Button>
          )}
          {examples.map((x) => (
            <Button key={x} size="sm" variant="ghost" disabled={busy} onClick={() => ask(x)}>
              {x}
            </Button>
          ))}
        </div>
      </Card>
      {(busy || answer || err) && (
        <Card className="p-4">
          {err && <p className="text-sm text-destructive">{err}</p>}
          {busy && !answer && <p className="text-sm text-muted-foreground">Analysing your data…</p>}
          {answer && (
            <div className="text-sm leading-relaxed">
              <Markdown text={answer} />
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
