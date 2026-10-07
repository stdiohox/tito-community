/**
 * Demo builds only: runs the real migrations (plus the demo-only tables)
 * once at build time and saves the resulting database as a snapshot, so a
 * cold demo server loads it in well under a second instead of running
 * initdb and every migration. The sample data itself is NOT in the
 * snapshot: it is applied at run time, so its dates stay relative to now.
 *
 * Runs as `prebuild`; does nothing unless DEMO_MODE=true.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { DEMO_SCHEMA } from "../src/lib/demo/seed";

async function main() {
  if (process.env.DEMO_MODE !== "true") return;
  const started = Date.now();
  const db = new PGlite();
  await db.exec(readFileSync(join("scripts", "supabase-stubs.sql"), "utf8"));
  for (const f of readdirSync(join("supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join("supabase", "migrations", f), "utf8"));
  }
  await db.exec(DEMO_SCHEMA);
  const dump = await db.dumpDataDir("gzip");
  mkdirSync(".demo", { recursive: true });
  writeFileSync(join(".demo", "schema.tar.gz"), Buffer.from(await dump.arrayBuffer()));
  await db.close();
  console.log(`[demo] schema snapshot built in ${Date.now() - started}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
