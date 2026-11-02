import { logoSrc } from "@/lib/brand";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/BranchPicker";
import { useMe, useSettings } from "@/lib/erp";
import { useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => ({ meta: [{ title: "Branding settings — Dealer ERP" }, { name: "description", content: "Company name, logo and invoice details." }] }),
  component: SettingsPage,
});

const fields = [
  ["company_name", "Company name"],
  ["tagline", "Tagline"],
  ["logo_url", "Logo image link (https://...)"],
  ["phone", "Phone"],
  ["address", "Address"],
] as const;

function SettingsPage() {
  const { t } = useT();
  const { data: me } = useMe();
  const { data } = useSettings();
  const qc = useQueryClient();
  const [f, setF] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setF(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v == null ? "" : String(v)])));
  }, [data]);

  async function save() {
    const { error } = await supabase.from("app_settings").update({
      company_name: f["company_name"] || "Dealer ERP",
      tagline: f["tagline"] || null, logo_url: f["logo_url"] || null, phone: f["phone"] || null,
      address: f["address"] || null, invoice_footer: f["invoice_footer"] || null, updated_at: new Date().toISOString(),
    }).eq("id", 1);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["settings"] });
  }

  const canEdit = !!me?.canWriteHq;
  return (
    <div className="max-w-2xl">
      <PageHeader title={t("Settings")} />
      <Card className="space-y-4 p-6">
        {fields.map(([k, l]) => (
          <div key={k} className="space-y-1">
            <Label>{l}</Label>
            <Input disabled={!canEdit} value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </div>
        ))}
        {<img src={logoSrc(f["logo_url"])} alt="Logo preview" className="h-16 w-auto rounded border object-contain p-1" />}
        <div className="space-y-1">
          <Label>Invoice / label footer</Label>
          <Textarea disabled={!canEdit} value={f["invoice_footer"] ?? ""} onChange={(e) => setF({ ...f, invoice_footer: e.target.value })} />
        </div>
        {canEdit && <Button onClick={save}>{t("Save")}</Button>}
      </Card>
    </div>
  );
}
