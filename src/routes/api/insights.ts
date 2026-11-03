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

        const body = (await request.json().catch(() => ({}))) as {
          question?: string;
          branchId?: string | null;
          days?: number;
        };
        const question = String(body.question ?? "")
          .slice(0, 2000)
          .trim();
        if (!question) return new Response("Please type a question", { status: 400 });
        const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const sinceDay = since.slice(0, 10);

        // All reads run as the signed-in user, so branch permissions apply.
        let salesQ = sb
          .from("sales")
          .select(
            "created_at,total,paid,discount,sale_type,payment_method,branch_id,sale_items(price,inventory_items(purchase_price,products(brand,model,variant)))",
          )
          .gte("created_at", since)
          .limit(3000);
        let invQ = sb
          .from("inventory_items")
          .select(
            "status,purchase_price,created_at,branch_id,products(brand,model,variant,sale_price)",
          )
          .in("status", ["in_stock", "in_transit"])
          .limit(5000);
        let expQ = sb
          .from("expenses")
          .select("amount,category,method,status,expense_date,branch_id")
          .gte("expense_date", sinceDay)
          .limit(2000);
        let txQ = sb
          .from("transactions")
          .select("kind,category,amount,method,branch_id,created_at")
          .gte("created_at", since)
          .limit(3000);
        let instQ = sb
          .from("installments")
          .select(
            "amount,paid_amount,due_date,branch_id,installment_plans(months,sales(invoice_no),customers(name))",
          )
          .eq("cancelled", false)
          .limit(4000);
        let purQ = sb
          .from("purchases")
          .select("total,paid,returned,branch_id,created_at,suppliers(name)")
          .gte("created_at", since)
          .limit(1000);
        if (body.branchId) {
          salesQ = salesQ.eq("branch_id", body.branchId);
          invQ = invQ.eq("branch_id", body.branchId);
          expQ = expQ.eq("branch_id", body.branchId);
          txQ = txQ.eq("branch_id", body.branchId);
          instQ = instQ.eq("branch_id", body.branchId);
          purQ = purQ.eq("branch_id", body.branchId);
        }
        const [
          { data: sales },
          { data: inv },
          { data: branches },
          { data: expenses },
          { data: tx },
          { data: inst },
          { data: purchases },
        ] = await Promise.all([
          salesQ,
          invQ,
          sb.from("branches").select("id,name"),
          expQ,
          txQ,
          instQ,
          purQ,
        ]);
        const bName = new Map((branches ?? []).map((b) => [b.id, b.name]));

        type Agg = { units: number; revenue: number; profit: number };
        const byModel: Record<string, Agg> = {},
          byBranch: Record<string, Agg & { sales: number }> = {},
          byDay: Record<string, number> = {};
        const mix: Record<string, number> = {};
        let revenue = 0,
          paid = 0,
          discount = 0;
        for (const s of sales ?? []) {
          const total = Number(s.total);
          const items = s.sale_items ?? [];
          const sumPrice = items.reduce((a, it) => a + Number(it.price), 0);
          revenue += total;
          paid += Number(s.paid);
          discount += Number(s.discount);
          mix[`${s.sale_type}/${s.payment_method}`] =
            (mix[`${s.sale_type}/${s.payment_method}`] ?? 0) + 1;
          const d = s.created_at.slice(0, 10);
          byDay[d] = (byDay[d] ?? 0) + total;
          const bn = bName.get(s.branch_id) ?? "?";
          const b = (byBranch[bn] ??= { units: 0, revenue: 0, profit: 0, sales: 0 });
          b.sales++;
          b.revenue += total;
          for (const it of items) {
            const p = it.inventory_items?.products;
            const m = p ? `${p.brand} ${p.model}${p.variant ? " " + p.variant : ""}` : "Unknown";
            const g = (byModel[m] ??= { units: 0, revenue: 0, profit: 0 });
            // Spread the amount actually charged over the lines, so model revenue
            // adds up to the invoice total even when the invoice carried a discount.
            const share = sumPrice > 0 ? (total * Number(it.price)) / sumPrice : 0;
            const cost = Number(it.inventory_items?.purchase_price ?? 0);
            g.units++;
            g.revenue += share;
            g.profit += share - cost;
            b.units++;
            b.profit += share - cost;
          }
        }
        const stock: Record<string, { qty: number; value: number; oldestDays: number }> = {};
        for (const i of inv ?? []) {
          const p = i.products;
          const m = p ? `${p.brand} ${p.model}${p.variant ? " " + p.variant : ""}` : "Unknown";
          const g = (stock[m] ??= { qty: 0, value: 0, oldestDays: 0 });
          g.qty++;
          g.value += Number(i.purchase_price);
          g.oldestDays = Math.max(
            g.oldestDays,
            Math.floor((Date.now() - new Date(i.created_at).getTime()) / 86400000),
          );
        }
        const r = (n: number) => Math.round(n);

        // Expenses — where the money went besides stock.
        const expByCategory: Record<string, number> = {};
        const expByMethod: Record<string, number> = {};
        let expTotal = 0;
        let expPending = 0;
        let expPendingAmount = 0;
        for (const e of expenses ?? []) {
          const amt = Number(e.amount);
          expTotal += amt;
          const cat = e.category || "Other";
          expByCategory[cat] = (expByCategory[cat] ?? 0) + amt;
          const m = e.method || "cash";
          expByMethod[m] = (expByMethod[m] ?? 0) + amt;
          if (e.status === "pending") {
            expPending++;
            expPendingAmount += amt;
          }
        }

        // Cash book — inflow and outflow per cash box.
        const cashIn: Record<string, number> = {};
        const cashOut: Record<string, number> = {};
        let inflow = 0;
        let outflow = 0;
        for (const t of tx ?? []) {
          const amt = Number(t.amount);
          const m = t.method || "cash";
          if (t.kind === "income") {
            inflow += amt;
            cashIn[m] = (cashIn[m] ?? 0) + amt;
          } else {
            outflow += amt;
            cashOut[m] = (cashOut[m] ?? 0) + amt;
          }
        }
        const cashByMethod: Record<string, { in: number; out: number; net: number }> = {};
        for (const m of new Set([...Object.keys(cashIn), ...Object.keys(cashOut)])) {
          const i = cashIn[m] ?? 0;
          const o = cashOut[m] ?? 0;
          cashByMethod[m] = { in: r(i), out: r(o), net: r(i - o) };
        }

        // Kisti — billed, collected, and what is late.
        const today = new Date().toISOString().slice(0, 10);
        let kistiBilled = 0;
        let kistiCollected = 0;
        let kistiOutstanding = 0;
        let kistiOverdue = 0;
        let kistiOverdueCount = 0;
        const kistiByMonth: Record<string, number> = {};
        const worstDebtors: Record<string, { name: string; due: number }> = {};
        for (const i of inst ?? []) {
          const due = Math.max(0, Number(i.amount) - Number(i.paid_amount));
          kistiBilled += Number(i.amount);
          kistiCollected += Number(i.paid_amount);
          kistiOutstanding += due;
          if (due > 0 && i.due_date < today) {
            kistiOverdue += due;
            kistiOverdueCount++;
          }
          const cust = i.installment_plans?.customers?.name ?? "Unknown";
          if (due > 0) {
            worstDebtors[cust] = { name: cust, due: (worstDebtors[cust]?.due ?? 0) + due };
          }
          const month = i.due_date.slice(0, 7);
          kistiByMonth[month] = (kistiByMonth[month] ?? 0) + due;
        }

        // Purchases — what was bought and what is still unpaid to suppliers.
        const purBySupplier: Record<string, number> = {};
        let purTotal = 0;
        let purPaid = 0;
        for (const p of purchases ?? []) {
          const total = Number(p.total);
          const paid = Number(p.paid);
          purTotal += total;
          purPaid += paid;
          const name = p.suppliers?.name ?? "Unknown";
          purBySupplier[name] = (purBySupplier[name] ?? 0) + total;
        }

        const facts = {
          period_days: days,
          branch: body.branchId
            ? (bName.get(body.branchId) ?? "selected")
            : "all accessible branches",
          totals: {
            sales: (sales ?? []).length,
            revenue: r(revenue),
            collected: r(paid),
            discount: r(discount),
          },
          sale_mix: mix,
          daily_revenue: Object.fromEntries(Object.entries(byDay).sort()),
          by_branch: byBranch,
          by_model: Object.entries(byModel)
            .sort((a, b) => b[1].revenue - a[1].revenue)
            .slice(0, 40),
          stock_on_hand: Object.entries(stock)
            .sort((a, b) => b[1].value - a[1].value)
            .slice(0, 60),
          expenses: {
            total: r(expTotal),
            by_category: Object.fromEntries(
              Object.entries(expByCategory)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 25),
            ),
            by_method: expByMethod,
            pending_count: expPending,
            pending_amount: r(expPendingAmount),
          },
          cash: {
            inflow: r(inflow),
            outflow: r(outflow),
            net: r(inflow - outflow),
            by_method: cashByMethod,
          },
          kisti: {
            billed: r(kistiBilled),
            collected: r(kistiCollected),
            outstanding: r(kistiOutstanding),
            overdue_amount: r(kistiOverdue),
            overdue_count: kistiOverdueCount,
            due_by_month: Object.fromEntries(Object.entries(kistiByMonth).sort()),
            top_debtors: Object.values(worstDebtors)
              .sort((a, b) => b.due - a.due)
              .slice(0, 15),
          },
          purchases: {
            count: (purchases ?? []).length,
            total: r(purTotal),
            paid: r(purPaid),
            due: r(purTotal - purPaid),
            by_supplier: Object.fromEntries(
              Object.entries(purBySupplier)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20),
            ),
          },
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
              const txt = await res
                .clone()
                .text()
                .catch(() => "");
              throw Object.assign(new Error(txt.slice(0, 300) || `AI error ${res.status}`), {
                status: res.status,
              });
            }
            return res;
          },
        });
        const result = streamText({
          model: provider.responses("openai/gpt-6-astra"),
          maxRetries: 0,
          abortSignal: request.signal,
          system:
            "You are a retail analyst for a Bangladeshi mobile phone showroom chain. Amounts are in BDT (৳). Answer the manager's question using ONLY the JSON facts provided. The facts cover sales and profit, stock on hand, expenses, the cash book (income vs expense per payment method), kisti dues and ageing, and purchases from suppliers. Be concise, use short markdown sections: **Summary**, **Trends**, **Opportunities** (concrete, actionable: restock, discount slow stock, transfer between branches, push models, chase overdue kisti, cut an expense category). Reply in the same language as the question (English or Bangla). If data is insufficient, say so.",
          messages: [
            { role: "user", content: `Question: ${question}\n\nFacts:\n${JSON.stringify(facts)}` },
          ],
          providerOptions: {
            openai: {
              store: false,
              forceReasoning: true,
              reasoningEffort: "low",
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          },
          onError: ({ error }) => console.error("insights AI error", error),
        });
        const res = result.toTextStreamResponse({
          headers: { "Cache-Control": "no-cache, no-transform" },
        });
        if (runId) res.headers.set(RUN, runId);
        return res;
      },
    },
  },
});
