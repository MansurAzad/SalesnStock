/**
 * Applies the drizzle migrations to a Postgres database, in journal order.
 *
 * Every file runs inside its own transaction, so a file either lands whole or
 * leaves nothing behind.
 */
const fs = require("fs");
const path = require("path");
const postgres = require("postgres").default;

const root = path.join(__dirname, "..");
const journal = JSON.parse(
  fs.readFileSync(path.join(root, "drizzle", "migrations", "meta", "_journal.json"), "utf8"),
);

const CONN = process.env.DB_URL;
if (!CONN) {
  console.error("Set DB_URL to the postgres connection string.");
  process.exit(1);
}
const only = process.argv.slice(2);

const sql = postgres(CONN, { max: 1, connect_timeout: 20 });

(async () => {
  let failed = 0;
  for (const entry of journal.entries) {
    const file = path.join(root, "drizzle", "migrations", `${entry.tag}.sql`);
    if (!fs.existsSync(file)) {
      console.log(`skip   ${entry.tag} (file missing)`);
      continue;
    }
    if (only.length && !only.some((o) => entry.tag.includes(o))) continue;

    const body = fs.readFileSync(file, "utf8");
    const started = Date.now();
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(body).simple();
      });
      console.log(`ok     ${entry.tag}  (${body.length} bytes, ${Date.now() - started}ms)`);
    } catch (e) {
      failed++;
      console.log(`FAIL   ${entry.tag}`);
      console.log(`       ${String(e.message).replace(/\n/g, " ").slice(0, 400)}`);
      console.log(`       ${e.position ? `position ${e.position}` : ""}`);
      break;
    }
  }
  await sql.end();
  process.exit(failed ? 1 : 0);
})();
