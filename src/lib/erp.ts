import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllPages } from "@/lib/paginated-query";

export const taka = (n: number | string | null | undefined) =>
  "৳" + Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

export const HQ_ROLES = ["super_admin", "dealer_admin", "accountant", "auditor"];
export const HQ_WRITE = ["super_admin", "dealer_admin"];

export type Me = {
  id: string;
  email: string | null;
  full_name: string | null;
  branch_id: string | null;
  roles: string[];
  isHq: boolean;
  canWriteHq: boolean;
};

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async (): Promise<Me> => {
      const { data: u } = await supabase.auth.getUser();
      const id = u.user!.id;
      const [{ data: p }, { data: r }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", id).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", id),
      ]);
      const roles = (r ?? []).map((x) => x.role as string);
      return {
        id,
        email: p?.email ?? u.user!.email ?? null,
        full_name: p?.full_name ?? null,
        branch_id: p?.branch_id ?? null,
        roles,
        isHq: roles.some((x) => HQ_ROLES.includes(x)),
        canWriteHq: roles.some((x) => HQ_WRITE.includes(x)),
      };
    },
  });
}

export function useBranches() {
  return useQuery({
    queryKey: ["branches"],
    queryFn: async () => {
      return fetchAllPages(supabase.from("branches").select("*").order("is_dealer_house", { ascending: false }).order("name"));
    },
  });
}

export function useProducts() {
  return useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      return fetchAllPages(supabase.from("products").select("*").order("brand").order("model"));
    },
  });
}

export const productLabel = (p?: { brand: string; model: string; variant: string | null } | null) =>
  p ? `${p.brand} ${p.model}${p.variant ? " " + p.variant : ""}` : "—";

export const roleLabel: Record<string, string> = {
  super_admin: "Super Admin",
  dealer_admin: "Dealer House Admin",
  branch_manager: "Branch Manager",
  sales: "Sales / Cashier",
  accountant: "Accountant",
  auditor: "Auditor",
};

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("app_settings").select("*").eq("id", 1).maybeSingle();
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60_000,
  });
}
