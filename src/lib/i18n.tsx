import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Lang = "en" | "bn";

const dict: Record<string, string> = {
  Dashboard: "ড্যাশবোর্ড",
  Menu: "মেনু",
  Online: "অনলাইন",
  "Offline sync": "অফলাইন সিঙ্ক",
  "waiting to sync": "সিঙ্কের অপেক্ষায়",
  "need attention": "দেখা দরকার",
  "Offline — sales, kisti and expenses are saved on this device":
    "অফলাইন — বিক্রি, কিস্তি ও খরচ এই ডিভাইসে সংরক্ষিত হচ্ছে",
  Inventory: "স্টক",
  Transfers: "স্টক ট্রান্সফার",
  Purchases: "ক্রয়",
  Expenses: "খরচ",
  POS: "বিক্রয় (POS)",
  Sales: "বিক্রয় তালিকা",
  Customers: "কাস্টমার",
  Installments: "কিস্তি",
  Accounts: "হিসাব",
  Branches: "শোরুম",
  Users: "ইউজার ও রোল",
  "Sign out": "লগআউট",
  "All branches": "সব শোরুম",
  "No branch assigned": "কোনো শোরুম নির্ধারিত নেই",
  "Today's sales": "আজকের বিক্রয়",
  "Month sales": "এই মাসের বিক্রয়",
  "In stock": "স্টকে আছে",
  "Due installments": "বকেয়া কিস্তি",
  "Cash balance": "নগদ ব্যালান্স",
  "Recent sales": "সাম্প্রতিক বিক্রয়",
  Branch: "শোরুম",
  Product: "পণ্য",
  Status: "অবস্থা",
  Price: "মূল্য",
  Total: "মোট",
  Paid: "পরিশোধিত",
  Due: "বকেয়া",
  Customer: "কাস্টমার",
  Name: "নাম",
  Phone: "ফোন",
  Address: "ঠিকানা",
  Save: "সংরক্ষণ",
  Add: "যোগ করুন",
  Search: "খুঁজুন",
  Income: "আয়",
  Expense: "ব্যয়",
  Date: "তারিখ",
  Amount: "পরিমাণ",
  Category: "খাত",
  Note: "নোট",
  Receive: "গ্রহণ করুন",
  Pay: "জমা নিন",
  Discount: "ছাড়",
  Cash: "নগদ",
  Installment: "কিস্তি",
  Checkout: "বিক্রয় সম্পন্ন",
  Cart: "কার্ট",
  Role: "রোল",
  "Add stock": "স্টক যোগ",
  "New transfer": "নতুন ট্রান্সফার",
  "Scan or type IMEI": "IMEI স্ক্যান বা টাইপ করুন",
  Products: "পণ্য তালিকা",
  Reports: "রিপোর্ট",
  "AI insights": "এআই বিশ্লেষণ",
  "Audit log": "অডিট লগ",
  Finance: "ফাইন্যান্স পার্টনার",
  Employees: "কর্মচারী ও হাজিরা",
  Labels: "বারকোড লেবেল",
  Settings: "সেটিংস",
  "Income category": "আয়ের খাত",
};

const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void; t: (s: string) => string }>({
  lang: "en",
  setLang: () => {},
  t: (s) => s,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");
  useEffect(() => {
    const v = localStorage.getItem("lang");
    if (v === "bn" || v === "en") setLangState(v);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang === "bn" ? "bn" : "en";
  }, [lang]);
  const setLang = (l: Lang) => {
    setLangState(l);
    localStorage.setItem("lang", l);
    document.documentElement.lang = l === "bn" ? "bn" : "en";
  };
  const t = (s: string) => (lang === "bn" ? (dict[s] ?? s) : s);
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>;
}

export const useT = () => useContext(Ctx);
