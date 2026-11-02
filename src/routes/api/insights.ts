import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import type { Database } from "@/integrations/supabase/types";

const RUN = "X-Lovable-AIG-Run-ID";

export const Route = createFileRoute("/api/insights")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return new Response("Sign in required", { status: 401 });
        const url = process.env["SUPABASE_URL"]!;
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const sb = createClient<Database>(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { headers: { Authorization: `Bearer ${token}` } },
        });
        const { data: u } = await sb.auth.getUser(token);
        if (!u.user) return new Response("Sign in required", { status: 401 });

        const body = (await request.json().catch(() => ({}))) as { question?: string; branchId?: string | null; days?: number };
        const question = String(body.question ?? "").slice(0, 2000).trim();
        if (!question) return new Response("Please type a question", { status: 400 });
        const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86400000).toISOString();

        // All reads run as the signed-in user, so branch permissions apply.
        let salesQ = sb.from("sales").select("created_at,total,paid,discount,sale_type,payment_method,branch_id,sale_items(price,inventory_items(purchase_price,products(brand,model,variant)))").gte("created_at", since).limit(3000);
        let invQ = sb.from("inventory_items").select("status,purchase_price,created_at,branch_id,products(brand,model,variant,sale_price)").in("status", ["in_stock", "in_transit"]).limit(5000);
        if (body.branchId) { salesQ = salesQ.eq("branch_id", body.branchId); invQ = invQ.eq("branch_id", body.branchId); }
        const [{ data: sales }, { data: inv }, { data: branches }] = await Promise.all([salesQ, invQ, sb.from("branches").select("id,name")]);
        const bName = new Map((branches ?? []).map((b) => [b.id, b.name]));

        type Agg = { units: number; revenue: number; profit: number };
        const byModel: Record<string, Agg> = {}, byBranch: Record<string, Agg & { sales: number }> = {}, byDay: Record<string, number> = {};
        const mix: Record<string, number> = {};
        let revenue = 0, paid = 0, discount = 0;
        for (const s of sales ?? []) {
          revenue += Number(s.total); paid += Number(s.paid); discount += Number(s.discount);
          mix[`${s.sale_type}/${s.payment_method}`] = (mix[`${s.sale_type}/${s.payment_method}`] ?? 0) + 1;
          const d = s.created_at.slice(0, 10); byDay[d] = (byDay[d] ?? 0) + Number(s.total);
          const bn = bName.get(s.branch_id) ?? "?"; const b = (byBranch[bn] ??= { units: 0, revenue: 0, profit: 0, sales: 0 }); b.sales++; b.revenue += Number(s.total);
          for (const it of s.sale_items ?? []) {
            const p = it.inventory_items?.products; const m = p ? `${p.brand} ${p.model}${p.variant ? " " + p.variant : ""}` : "Unknown";
            const g = (byModel[m] ??= { units: 0, revenue: 0, profit: 0 }); const pr = Number(it.price) - Number(it.inventory_items?.purchase_price ?? 0);
            g.units++; g.revenue += Number(it.price); g.profit += pr; b.units++; b.profit += pr;
          }
        }
        const stock: Record<string, { qty: number; value: number; oldestDays: number }> = {};
        for (const i of inv ?? []) {
          const p = i.products; const m = p ? `${p.brand} ${p.model}${p.variant ? " " + p.variant : ""}` : "Unknown";
          const g = (stock[m] ??= { qty: 0, value: 0, oldestDays: 0 }); g.qty++; g.value += Number(i.purchase_price);
          g.oldestDays = Math.max(g.oldestDays, Math.floor((Date.now() - new Date(i.created_at).getTime()) / 86400000));
        }
        const r = (n: number) => Math.round(n);
        const facts = {
          period_days: days, branch: body.branchId ? bName.get(body.branchId) ?? "selected" : "all accessible branches",
          totals: { sales: (sales ?? []).length, revenue: r(revenue), collected: r(paid), discount: r(discount) },
          sale_mix: mix, daily_revenue: Object.fromEntries(Object.entries(byDay).sort()),
          by_branch: byBranch,
          by_model: Object.entries(byModel).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 40),
          stock_on_hand: Object.entries(stock).sort((a, b) => b[1].value - a[1].value).slice(0, 60),
        };

        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) return new Response("AI is not configured", { status: 500 });
        let runId: string | undefined;
        const provider = createOpenAI({
          baseURL: "https://ai.gateway.lovable.dev/v1",
          apiKey,
          headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
          fetch: async (input, init) => {
            const res = await fetch(input, init);
            runId ??= res.headers.get(RUN) ?? undefined;
            if (!res.ok) {
              const txt = await res.clone().text().catch(() => "");
              throw Object.assign(new Error(txt.slice(0, 300) || `AI error ${res.status}`), { status: res.status });
            }
            return res;
          },
        });
        const result = streamText({
          model: provider.responses("openai/gpt-6-astra"),
          maxRetries: 0,
          abortSignal: request.signal,
          system:
            "You are a retail analyst for a Bangladeshi mobile phone showroom chain. Amounts are in BDT (৳). Answer the manager's question using ONLY the JSON facts provided. Be concise, use short markdown sections: **Summary**, **Trends**, **Opportunities** (concrete, actionable: restock, discount slow stock, transfer between branches, push models). Reply in the same language as the question (English or Bangla). If data is insufficient, say so.",
          messages: [{ role: "user", content: `Question: ${question}\n\nFacts:\n${JSON.stringify(facts)}` }],
          providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
          onError: ({ error }) => console.error("insights AI error", error),
        });
        const res = result.toTextStreamResponse({ headers: { "Cache-Control": "no-cache, no-transform" } });
        if (runId) res.headers.set(RUN, runId);
        return res;
      },
    },
  },
});
