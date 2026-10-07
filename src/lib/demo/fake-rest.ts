import "server-only";
import { exec, type Claims, type Visitor } from "@/lib/demo/db";

/*
 * A small PostgREST for the demo: translates exactly the REST shapes that
 * supabase-js produces for this app into SQL, run against the visitor's
 * database AS THE CALLER'S ROLE, so RLS decides what comes back just as it
 * would on Supabase.
 */

// Writes that are bookkeeping, not part of the story: kept in memory only.
const EPHEMERAL_TABLES = new Set(["rate_limits", "notification_deliveries"]);
// RPCs that change data the visitor would expect to see again.
const PERSISTED_RPCS = new Set([
  "record_payment",
  "admin_extend_access",
  "admin_set_access_status",
  "claim_push_subscription",
  "claim_plan_creation",
  "finish_plan_creation",
  "release_plan_claim",
]);

const IDENT = /^[a-z_][a-z0-9_]*$/;

class RestError extends Error {
  constructor(
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(String(body.message));
  }
}

function selectList(raw: string | null): string {
  const s = (raw ?? "*").replace(/\s+/g, "");
  if (s === "*") return "*";
  const cols = s.split(",");
  if (!cols.every((c) => IDENT.test(c))) throw new RestError(400, { code: "PGRST100", message: `Unsupported select: ${raw}` });
  return cols.join(", ");
}

function filters(params: URLSearchParams, startAt = 0) {
  const where: string[] = [];
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return `$${startAt + values.length}`;
  };
  for (const [key, raw] of params) {
    if (["select", "limit", "offset", "order", "on_conflict", "columns"].includes(key)) continue;
    if (!IDENT.test(key)) throw new RestError(400, { code: "PGRST100", message: `Bad column ${key}` });
    let v = raw;
    let neg = false;
    if (v.startsWith("not.")) {
      neg = true;
      v = v.slice(4);
    }
    let clause: string;
    const m = v.match(/^(eq|neq|lt|lte|gt|gte|is|in)\.([\s\S]*)$/);
    if (!m) throw new RestError(400, { code: "PGRST100", message: `Unsupported filter ${key}=${raw}` });
    const [, op, arg] = m;
    if (op === "is") {
      if (!["null", "true", "false"].includes(arg)) throw new RestError(400, { code: "PGRST100", message: `Bad is.${arg}` });
      clause = `${key} is ${arg}`;
    } else if (op === "in") {
      const list = arg.replace(/^\(|\)$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, ""));
      if (list.length > 200) throw new RestError(400, { code: "PGRST100", message: "in() list too long for the demo" });
      clause = `${key}::text = any(${add(list)}::text[])`;
    } else {
      const sym = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[op]!;
      clause = `${key} ${sym} ${add(arg)}`;
    }
    where.push(neg ? `not (${clause})` : clause);
  }
  return { where: where.length ? ` where ${where.join(" and ")}` : "", values };
}

function orderBy(params: URLSearchParams): string {
  const o = params.get("order");
  if (!o) return "";
  return (
    " order by " +
    o
      .split(",")
      .map((part) => {
        const [col, ...mods] = part.split(".");
        if (!IDENT.test(col)) throw new RestError(400, { code: "PGRST100", message: `Bad order ${part}` });
        const dir = mods.includes("desc") ? "desc" : "asc";
        const nulls = mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : "";
        return `${col} ${dir}${nulls}`;
      })
      .join(", ")
  );
}

function pgError(e: unknown): RestError {
  const err = e as { code?: string; message?: string; detail?: string; hint?: string };
  const code = err.code ?? "P0001";
  const status = code === "42501" ? 403 : code === "23505" ? 409 : code === "P0002" ? 404 : 400;
  return new RestError(status, { code, message: err.message ?? String(e), details: err.detail ?? null, hint: err.hint ?? null });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

export async function handleRest(
  v: Visitor,
  url: URL,
  init: { method: string; headers: Headers; body: string | null },
  auth: { role: "anon" | "authenticated" | "service_role"; claims: Claims },
): Promise<Response> {
  const path = url.pathname.replace(/^.*\/rest\/v1\//, "");
  const method = init.method.toUpperCase();
  const prefer = init.headers.get("prefer") ?? "";
  const single = (init.headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const run = (sql: string, params: unknown[], persist = false, persistRowsOf?: string) =>
    exec<Record<string, unknown>>(v, sql, params, { claims: auth.claims, role: auth.role, persist, persistRowsOf });

  try {
    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      if (!IDENT.test(fn)) throw new RestError(404, { code: "PGRST202", message: `No function ${fn}` });
      const args = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const names = Object.keys(args);
      if (!names.every((n) => IDENT.test(n))) throw new RestError(400, { code: "PGRST100", message: "Bad argument name" });
      const sql = `select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`;
      const res = await run(sql, Object.values(args), PERSISTED_RPCS.has(fn));
      const scalar = res.fields.length === 1 && res.fields[0].name === fn;
      return json(200, scalar ? (res.rows[0]?.[fn] ?? null) : res.rows);
    }

    if (!IDENT.test(path)) throw new RestError(404, { code: "PGRST205", message: `No table ${path}` });
    const table = path;
    const persist = !EPHEMERAL_TABLES.has(table);
    const select = selectList(url.searchParams.get("select"));

    if (method === "GET" || method === "HEAD") {
      const { where, values } = filters(url.searchParams);
      const limit = url.searchParams.get("limit");
      const offset = url.searchParams.get("offset");
      // Clamped: one visitor's query must never stall the shared engine.
      const lim = Math.min(Math.max(Number(limit) || 500, 0), 500);
      const off = Math.min(Math.max(Number(offset) || 0, 0), 10000);
      const tail = `${orderBy(url.searchParams)} limit ${lim}${off ? ` offset ${off}` : ""}`;
      const res = await run(`select ${select} from public.${table}${where}${tail}`, values);
      const headers: Record<string, string> = {};
      if (prefer.includes("count=exact")) {
        const count = await run(`select count(*)::int as n from public.${table}${where}`, values);
        const n = count.rows[0].n as number;
        headers["content-range"] = res.rows.length ? `0-${res.rows.length - 1}/${n}` : `*/${n}`;
      }
      if (method === "HEAD") return new Response(null, { status: 200, headers });
      if (single) {
        if (res.rows.length !== 1) {
          throw new RestError(406, {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: `The result contains ${res.rows.length} rows`,
          });
        }
        return json(200, res.rows[0], headers);
      }
      return json(200, res.rows, headers);
    }

    if (method === "POST") {
      const parsed = JSON.parse(init.body ?? "[]") as Record<string, unknown> | Record<string, unknown>[];
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (rows.length === 0) return json(201, []);
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      if (!cols.every((c) => IDENT.test(c))) throw new RestError(400, { code: "PGRST100", message: "Bad column" });
      const params: unknown[] = [];
      const tuples = rows.map(
        (r) =>
          `(${cols
            .map((c) => {
              if (!(c in r)) return "default";
              const val = r[c];
              params.push(val !== null && typeof val === "object" && !(val instanceof Date) ? JSON.stringify(val) : val);
              return `$${params.length}`;
            })
            .join(", ")})`,
      );
      const upsert = prefer.includes("resolution=merge-duplicates") || prefer.includes("resolution=ignore-duplicates");
      let conflict = "";
      if (upsert) {
        const target = url.searchParams.get("on_conflict");
        if (!target || !target.split(",").every((c) => IDENT.test(c))) throw new RestError(400, { code: "PGRST100", message: "Upsert needs on_conflict" });
        conflict = prefer.includes("ignore-duplicates")
          ? ` on conflict (${target}) do nothing`
          : ` on conflict (${target}) do update set ${cols.filter((c) => !target.split(",").includes(c)).map((c) => `${c} = excluded.${c}`).join(", ")}`;
      }
      const sql = `insert into public.${table} (${cols.join(", ")}) values ${tuples.join(", ")}${conflict} returning *`;
      // Upserts carry explicit values and replay as-is; plain inserts are
      // logged as the full rows produced (ids, defaults, timestamps).
      // In one locked step with the insert, so the log keeps the true order.
      const res = await run(sql, params, persist && upsert, persist && !upsert ? table : undefined);
      if (!prefer.includes("return=representation")) return new Response(null, { status: 201 });
      const out = select === "*" ? res.rows : res.rows.map((r) => Object.fromEntries(select.split(", ").map((c) => [c, r[c]])));
      return json(201, single ? out[0] : out);
    }

    if (method === "PATCH") {
      const patch = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      const cols = Object.keys(patch);
      if (!cols.every((c) => IDENT.test(c))) throw new RestError(400, { code: "PGRST100", message: "Bad column" });
      const setParams = cols.map((c) => {
        const val = patch[c];
        return val !== null && typeof val === "object" && !(val instanceof Date) ? JSON.stringify(val) : val;
      });
      const { where, values } = filters(url.searchParams, setParams.length);
      const set = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
      const res = await run(`update public.${table} set ${set}${where} returning ${select}`, [...setParams, ...values], persist);
      if (!prefer.includes("return=representation")) return new Response(null, { status: 204 });
      return json(200, single ? (res.rows[0] ?? null) : res.rows);
    }

    if (method === "DELETE") {
      const { where, values } = filters(url.searchParams);
      const res = await run(`delete from public.${table}${where} returning ${select}`, values, persist);
      if (!prefer.includes("return=representation")) return new Response(null, { status: 204 });
      return json(200, res.rows);
    }

    throw new RestError(405, { code: "PGRST000", message: `Method ${method} not supported` });
  } catch (e) {
    const err = e instanceof RestError ? e : pgError(e);
    return json(err.status, err.body);
  }
}
