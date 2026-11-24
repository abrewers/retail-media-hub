// Unity Catalog reads through the app's SQL warehouse.
//
// The governed catalog and schema come from the bundle (env RMCC_CATALOG / RMCC_SCHEMA) and are
// passed as the statement's default catalog and schema, so the SQL in this app uses bare names
// (v_campaign_delivery, metric_view_campaign_delivery, dim_contract_terms, ...).
//
// Why server-side and not AppKit query files: every screen merges warehouse data with the app's
// own write-back history in Lakebase, and write routes validate against governed numbers.

import { WorkspaceClient } from '@databricks/sdk-experimental';

type Param = string | number | null;
export type Row = Record<string, string | number | boolean | null>;

const CATALOG = process.env.RMCC_CATALOG ?? '';
const SCHEMA = process.env.RMCC_SCHEMA ?? 'retail_media';
const NUMERIC = new Set(['BYTE', 'SHORT', 'INT', 'LONG', 'FLOAT', 'DOUBLE', 'DECIMAL']);

let client: WorkspaceClient | undefined;
const ws = () => (client ??= new WorkspaceClient({}));

function warehouseId(): string {
  const id = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!id) throw new Error('DATABRICKS_WAREHOUSE_ID is not set (sql-warehouse app resource missing)');
  return id;
}

function toParam(name: string, value: Param) {
  if (value === null) return { name, type: 'STRING' };
  if (typeof value === 'number') return { name, type: Number.isInteger(value) ? 'BIGINT' : 'DOUBLE', value: String(value) };
  return { name, type: 'STRING', value };
}

/** Run one SQL statement (named :params) and return typed rows. Polls up to maxWaitS seconds. */
export async function wq(statement: string, params: Record<string, Param> = {}, maxWaitS = 90): Promise<Row[]> {
  const sql = ws().statementExecution;
  let res = await sql.executeStatement({
    warehouse_id: warehouseId(),
    catalog: CATALOG,
    schema: SCHEMA,
    statement,
    parameters: Object.entries(params).map(([k, v]) => toParam(k, v)),
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
    format: 'JSON_ARRAY',
    disposition: 'INLINE',
  });
  for (let i = 0; (res.status?.state === 'PENDING' || res.status?.state === 'RUNNING') && i < maxWaitS - 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await sql.getStatement({ statement_id: res.statement_id ?? '' });
  }
  if (res.status?.state !== 'SUCCEEDED') {
    throw new Error(`warehouse query ${res.status?.state ?? 'UNKNOWN'}: ${res.status?.error?.message ?? ''}`);
  }
  const cols = res.manifest?.schema?.columns ?? [];
  return (res.result?.data_array ?? []).map((values) => {
    const row: Row = {};
    cols.forEach((c, i) => {
      const v = values[i] ?? null;
      const t = String(c.type_name ?? '');
      row[c.name ?? `c${i}`] = v === null ? null : NUMERIC.has(t) ? Number(v) : t === 'BOOLEAN' ? v === 'true' : v;
    });
    return row;
  });
}

const cache = new Map<string, { at: number; rows: Promise<Row[]> }>();

/** Cached read (default 60s). Governed numbers only change when setup re-runs. */
export function wqCached(key: string, statement: string, params: Record<string, Param> = {}, ttlMs = 60_000): Promise<Row[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rows;
  const rows = wq(statement, params);
  cache.set(key, { at: Date.now(), rows });
  rows.catch(() => cache.delete(key));
  return rows;
}

/** Calls a Databricks REST API as the app's service principal (used for the Files API). */
export async function dbxFetch(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  const cfg = ws().config;
  const headers = new Headers(init.headers);
  await cfg.authenticate(headers);
  const host = await cfg.getHost();
  return fetch(new URL(path, host), { ...init, headers });
}

export function clearWarehouseCache(): void {
  cache.clear();
}

export interface DemoConfig {
  asOfDate: string | null;
  genieSpaceId: string | null;
  appSeed: unknown;
  retailerName: string | null;
  extractSpec: ExtractSpec | null;
}

/** Contract extraction spec written by the setup job, so uploads are extracted exactly like setup's PDFs. */
export interface ExtractSpec {
  fields: Record<string, unknown>;
  casts: Record<string, string>;
  instructions: string;
  contracts_dir: string;
  samples: Record<string, string>;
}

/** Reads cfg_demo_config (written by the setup job). Returns empty values if setup hasn't run yet. */
export async function readDemoConfig(): Promise<DemoConfig> {
  try {
    // SELECT * so a cfg_demo_config written by an older setup (no retailer_name column) still loads.
    const [r] = await wq('SELECT *, CAST(as_of_date AS STRING) AS as_of_date_str FROM cfg_demo_config LIMIT 1');
    return {
      asOfDate: (r?.as_of_date_str as string) ?? null,
      genieSpaceId: (r?.genie_space_id as string) ?? null,
      appSeed: r?.app_seed ? JSON.parse(String(r.app_seed)) : null,
      retailerName: (r?.retailer_name as string) || null,
      extractSpec: r?.extract_spec ? (JSON.parse(String(r.extract_spec)) as ExtractSpec) : null,
    };
  } catch (err) {
    console.error('[config] cfg_demo_config not readable yet (run the setup job):', (err as Error).message);
    return { asOfDate: null, genieSpaceId: null, appSeed: null, retailerName: null, extractSpec: null };
  }
}
