# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

## Deploy to Vercel

This is a TanStack Start project; `nitro` (already a devDependency) detects
Vercel at build time and produces the Vercel Build Output API in
`.vercel/output`, which Vercel deploys automatically — no output-directory
setting is needed.

1. Push this repository to GitHub and import it in Vercel (**New Project**).
   `vercel.json` pins the install/build commands (`bun install`,
   `bun run build`), and Node.js 22 is selected automatically via
   `engines.node`.
2. Add the server runtime variables in **Vercel → Project Settings →
   Environment Variables** (see `.env.example`):

   | Variable | Required | Used by |
   | --- | --- | --- |
   | `SUPABASE_URL` | Yes | Server functions, SSR, API routes |
   | `SUPABASE_PUBLISHABLE_KEY` | Yes | Server functions, SSR, API routes |
   | `SUPABASE_SERVICE_ROLE_KEY` | No | Privileged admin operations (currently unused) |
   | `LOVABLE_API_KEY` | No | AI insights page (Lovable AI Gateway) |

   The browser-side `VITE_SUPABASE_*` values are embedded at build time from
   the committed `.env`, so no extra setting is needed for them.
3. Deploy, then add the new domain to your auth provider's allowed redirect
   URLs (Site URL / Redirect URLs in the backend auth settings) so sign-in
   works from the deployed URL.
4. Verify after the first deploy: a page renders server-side, direct
   navigation to a nested route works (e.g. open `/inventory` directly),
   and sign-in plus a server-function round trip (e.g. record a sale)
   succeed.

Note: the AI insights page needs the Lovable AI Gateway key, which is
provisioned only on Lovable hosting. On Vercel it responds
"AI is not configured" unless a compatible gateway key is provided in
`LOVABLE_API_KEY`.

## ডেটাবেস

ডেটাবেস সরাসরি Supabase Postgres-এ থাকে, তাই `drizzle-kit` এখানে কাজ করে না।
মাইগ্রেশনগুলো `drizzle/migrations/` ফোল্ডারে আছে এবং এগুলো প্রয়োগ করতে হয়
DB_URL সেট করে:

```sh
export DB_URL="postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
npm run db:migrate   # সব মাইগ্রেশন ক্রমানুসারে প্রয়োগ করে
npm run db:check     # টেবিল, কলাম, ফাংশন ও RLS যাচাই করে
npm run db:smoke     # এন্ড-টু-এন্ড টেস্ট (৬৮টি চেক)
```

`npm run db:smoke` একটি মাত্র ট্রানজ্যাকশনের ভেতরে সব দৃশ্য চালায় এবং শেষে
সেটি রোলব্যাক করে — লাইভ ডেটা অক্ষত থাকে। টেস্টটি ব্যবহারকারীদের `SET ROLE
authenticated` ও নকল JWT দিয়ে সিমুলেট করে, তাই RLS ও পারমিশন চেক ব্রাউজারের
মতোই কাজ করে। বিকল হলে এটি সমস্যার লাইন নম্বর দেখায়।

