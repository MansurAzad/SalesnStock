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
  "Due date": "পরিশোধের তারিখ",
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
  "Overdue kisti": "অতিরিক্ত কিস্তি",
  "Needs attention": "দেখা দরকার",
  "kisti overdue": "টি কিস্তির চক্ষু পেরিয়েছে",
  "models below reorder level": "মডেল রিওর্ডার লেভেলের নিচে",
  "finance cases pending": "ফাইন্যান্স কেস অপেক্ষমাণ",
  "expenses awaiting approval": "খরচ অনুমোদনের অপেক্ষায়",
  "Kisti ageing": "কিস্তির বয়স",
  Overdue: "অতিরিক্ত",
  "Next 30 days": "পরবর্তী ৩০ দিন",
  "31–60 days": "৩১–৬০ দিন",
  Later: "পরে",
  kistis: "টি কিস্তি",
  Invoice: "ইনভয়েস",
  Type: "ধরন",
  Receipt: "রসিদ",
  "Low stock": "স্টক কম",
  "Reorder at": "রিওর্ডার লেভেল",
  "Short by": "ঘাটতি",
  "No sales this month yet.": "এই মাসে এখনও কোনো বিক্রয় হয়নি।",
  // The ten expense heads
  "Shop rent": "দোকান ভাড়া",
  "Electricity bill": "বিদ্যুৎ বিল",
  "Internet bill": "ইন্টারনেট বিল",
  "Staff salary": "কর্মচারীদের বেতন",
  Food: "খাবার",
  Transport: "যাতায়াত",
  Cleaning: "পরিষ্কার-পরিচ্ছন্নতা",
  Repair: "শোরুম মেরামত",
  Marketing: "প্রচারণা ও মার্কেটিং",
  Other: "অন্যান্য আনুষঙ্গিক",
  // Expenses screen
  Voucher: "ভাউচার",
  Bill: "বিল",
  "Bill / token no": "বিল / টোকেন নম্বর",
  "Add expense": "খরচ যোগ করুন",
  Method: "পদ্ধতি",
  "Approved by": "অনুমোদনকারী",
  // Reports
  "Stock ledger": "স্টক খতিয়ান",
  // Daily cash book
  "Daily cash": "দৈনিক ক্যাশ",
  "Money in": "আসল অর্থ",
  "Money out": "গোযা অর্থ",
  "Opening cash": "শুরুর নগদ",
  "Cash sales": "নগদ বিক্রয়",
  "Bank / card sales": "ব্যাংক / কার্ড বিক্রয়",
  "MFS sales": "বিকাশ / নগদ / রকেট বিক্রয়",
  "Sold on kisti today, still to collect": "আজ কিস্তিতে বিক্রয়, বকেয়া",
  "Kisti collected today": "আজ কিস্তি আদায়",
  "of which cash": "তার মধ্যে নগদ",
  "of which bKash / Nagad / Rocket": "তার মধ্যে বিকাশ / নগদ / রকেট",
  "Other income today": "আজ অন্যান্য আয়",
  "Expenses today": "আজ খরচ",
  "Deposited to head office": "প্রধান অফিসে জমা",
  "Closing cash": "দিনের শেষ নগদ",
  "opening + cash sales + cash collected − cash spent − cash deposited":
    "শুরুর নগদ + নগদ বিক্রয় + নগদ আদায় − নগদ খরচ − অফিসে জমা",
  "Counted in the drawer": "হাতে গোনা নগদ",
  Variance: "তারতাম্য",
  Balanced: "মিলে গেছে",
  "Not counted yet": "এখনও গোনা হয়নি",
  "Does not match the drawer": "হাতে থাকা নগদের সঙ্গে মেলেনি",
  "Counted cash at close": "দিন শেষে গোনা নগদ",
  "Any explanation of a difference": "তারতাম্যের কারণ লিখুন",
  "Save day book": "দিনের হিসাব সংরক্ষণ",
  "Deposit to head office": "প্রধান অফিসে জমা",
  "Slip or reference": "স্লিপ / রেফারেন্স",
  "Record deposit": "জমা লিখুন",
  Today: "আজ",
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
