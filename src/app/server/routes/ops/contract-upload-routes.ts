// Upload a signed IO PDF on a campaign's Contract tab and extract its terms, the same way the setup job does.
//
// 1. The PDF is written to the contracts volume as c<campaign_id>__<name>.pdf (the prefix links it to the campaign,
//    so the setup job keeps the link if it ever re-extracts the file).
// 2. ai_parse_document + ai_extract run on the SQL warehouse with the spec setup wrote to cfg_demo_config.extract_spec.
// 3. The terms are merged into dim_contract_terms. Genie, the Contract tab and the make-good drawer read that table,
//    so the new contract shows up in all three without re-running setup.
// Everything runs as the app's service principal; setup grants it WRITE VOLUME and MODIFY on dim_contract_terms.

import type { Request } from 'express';
import { campaignById } from './governed';
import type { AppKitWithLakebase } from './ops-db';
import { fail, parseId, userEmail } from './ops-db';
import { clearWarehouseCache, dbxFetch, type ExtractSpec, wq, wqCached } from './warehouse';

const MAX_BYTES = 10 * 1024 * 1024;
const UPLOADED = (id: number) => `/c${id}__`;

type JobState = 'extracting' | 'done' | 'no_terms' | 'failed';
interface Job { campaignId: number; state: JobState; message: string; startedAt: number }
const jobs = new Map<string, Job>();

/** SQL string literal (backslash escapes, as in the setup notebook). */
const lit = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const filesUrl = (path: string) => `/api/2.0/fs/files${encodeURI(path)}`;

function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? 'contract').toLowerCase().replace(/\.pdf$/, '');
  const clean = base.replace(/[^a-z0-9._-]+/g, '_').replace(/^[._]+|_+$/g, '').slice(0, 80) || 'contract';
  return `${clean}.pdf`;
}

async function readBody(req: Request, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function deleteFile(path: string): Promise<void> {
  const r = await dbxFetch(filesUrl(path), { method: 'DELETE' });
  if (!r.ok && r.status !== 404) throw new Error(`delete ${path}: HTTP ${r.status}`);
}

/** Runs the extraction for one uploaded file and records the result on the job. */
async function extract(jobId: string, spec: ExtractSpec, path: string, campaignId: number, who: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  try {
    const [row] = await wq(
      `SELECT _metadata.file_path AS source_file, CAST(_metadata.file_modification_time AS STRING) AS file_modified,
              CAST(ai_extract(ai_parse_document(content, map('version', '2.0')), ${lit(JSON.stringify(spec.fields))},
                              map('version', '2.1', 'instructions', ${lit(spec.instructions)})) AS STRING) AS x
       FROM read_files(${lit(path)}, format => 'binaryFile')`, {}, 300);
    if (!row) throw new Error('the uploaded file was not found in the volume');
    const out = JSON.parse(String(row.x)) as { error_message?: string | null; response?: Record<string, unknown> };
    if (out.error_message) throw new Error(out.error_message);
    const rec: Record<string, string | null> = {};
    for (const k of Object.keys(spec.fields)) {
      const v = out.response?.[k];
      const val = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? (v as { value: unknown }).value : v;
      rec[k] = val === null || val === undefined ? null : typeof val === 'string' ? val : JSON.stringify(val);
    }
    if (rec.makegood_threshold_pct === null && rec.makegood_clause_summary === null) {
      await deleteFile(path);
      Object.assign(job, { state: 'no_terms', message: 'No make-good terms were found in this PDF, so it was not added. Is it a signed IO?' });
      return;
    }
    const cols = Object.keys(spec.fields)
      .map((k) => (spec.casts[k] ? `CAST(:f_${k} AS ${spec.casts[k]}) AS ${k}` : `:f_${k} AS ${k}`)).join(', ');
    const params: Record<string, string | number | null> = { campaign_id: campaignId, source_file: String(row.source_file), file_modified: String(row.file_modified), who };
    for (const [k, v] of Object.entries(rec)) params[`f_${k}`] = v;
    await wq(
      `MERGE INTO dim_contract_terms t
       USING (SELECT CAST(:campaign_id AS INT) AS campaign_id, ${cols}, :source_file AS source_file,
                     CAST(:file_modified AS TIMESTAMP) AS file_modified, current_timestamp() AS extracted_at, :who AS uploaded_by) s
       ON t.source_file = s.source_file
       WHEN MATCHED THEN UPDATE SET *
       WHEN NOT MATCHED THEN INSERT *`, params, 120);
    clearWarehouseCache();
    Object.assign(job, { state: 'done', message: 'Terms extracted. Genie and the make-good drawer now use this contract.' });
  } catch (err) {
    console.error('[contracts] extraction failed:', err);
    await deleteFile(path).catch(() => undefined);
    Object.assign(job, { state: 'failed', message: `Extraction failed: ${(err as Error).message.slice(0, 200)}` });
  }
}

/** Reset demo: removes every IO uploaded in the app (files and extracted terms). Returns how many. */
export async function removeAllUploads(): Promise<number> {
  const rows = await wq("SELECT source_file FROM dim_contract_terms WHERE source_file RLIKE '/c[0-9]+__[^/]*$'");
  for (const r of rows) await deleteFile(String(r.source_file).replace(/^dbfs:/, ''));
  if (rows.length > 0) await wq("DELETE FROM dim_contract_terms WHERE source_file RLIKE '/c[0-9]+__[^/]*$'");
  return rows.length;
}

export function registerContractUploadRoutes(appkit: AppKitWithLakebase, spec: ExtractSpec | null): void {
  appkit.server.extend((app) => {
    // Which campaigns have a signed IO on file (for the Campaigns table). { "<campaign_id>": { uploaded } }
    app.get('/api/contracts/status', async (_req, res) => {
      try {
        const rows = await wqCached('contract-status',
          "SELECT campaign_id, MAX(source_file RLIKE '/c[0-9]+__[^/]*$') AS uploaded FROM dim_contract_terms WHERE campaign_id IS NOT NULL GROUP BY campaign_id");
        res.json(Object.fromEntries(rows.map((r) => [String(r.campaign_id), { uploaded: Boolean(r.uploaded) }])));
      } catch (err) {
        fail(res, 'Load contract status', err);
      }
    });

    app.post('/api/campaigns/:id/contract', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) { res.status(400).json({ error: 'Invalid campaign id' }); return; }
      if (!spec) { res.status(503).json({ error: 'Contract upload needs the latest setup job: re-run setup, then restart the app.' }); return; }
      try {
        if (!(await campaignById(id))) { res.status(404).json({ error: 'Campaign not found' }); return; }
        if ([...jobs.values()].some((j) => j.campaignId === id && j.state === 'extracting')) {
          res.status(409).json({ error: 'An upload for this campaign is already being extracted.' }); return;
        }
        const existing = await wq('SELECT source_file FROM dim_contract_terms WHERE campaign_id = :id', { id });
        if (existing.length > 0) {
          const uploaded = existing.some((r) => String(r.source_file).includes(UPLOADED(id)));
          res.status(409).json({ error: uploaded ? 'Remove the uploaded IO first, then upload the new one.' : 'This campaign already has a signed IO on file.' }); return;
        }
        const body = await readBody(req, MAX_BYTES);
        if (!body) { res.status(413).json({ error: 'PDF is larger than 10 MB.' }); return; }
        if (body.subarray(0, 5).toString('latin1') !== '%PDF-') { res.status(415).json({ error: 'That file is not a PDF.' }); return; }
        const path = `${spec.contracts_dir.replace(/\/?$/, '/')}c${id}__${safeName(typeof req.query.name === 'string' ? req.query.name : 'contract.pdf')}`;
        const put = await dbxFetch(`${filesUrl(path)}?overwrite=true`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(body) });
        if (!put.ok) throw new Error(`upload to volume: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
        const jobId = `${id}-${Date.now()}`;
        jobs.set(jobId, { campaignId: id, state: 'extracting', message: 'Reading the PDF with ai_parse_document and ai_extract…', startedAt: Date.now() });
        void extract(jobId, spec, path, id, userEmail(req));
        res.status(202).json({ jobId });
      } catch (err) {
        fail(res, 'Upload contract', err);
      }
    });

    app.get('/api/contract-jobs/:jobId', (req, res) => {
      const job = jobs.get(req.params.jobId);
      if (!job) { res.status(404).json({ error: 'Unknown upload' }); return; }
      res.json({ state: job.state, message: job.message, seconds: Math.round((Date.now() - job.startedAt) / 1000) });
    });

    app.delete('/api/campaigns/:id/contract', async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) { res.status(400).json({ error: 'Invalid campaign id' }); return; }
      try {
        const rows = await wq('SELECT source_file FROM dim_contract_terms WHERE campaign_id = :id', { id });
        const mine = rows.map((r) => String(r.source_file)).filter((f) => f.includes(UPLOADED(id)));
        if (mine.length === 0) { res.status(409).json({ error: 'Only IOs uploaded in the app can be removed here.' }); return; }
        for (const f of mine) await deleteFile(f.replace(/^dbfs:/, ''));
        await wq(`DELETE FROM dim_contract_terms WHERE campaign_id = :id AND source_file LIKE :pat`, { id, pat: `%${UPLOADED(id)}%` });
        clearWarehouseCache();
        res.json({ ok: true });
      } catch (err) {
        fail(res, 'Remove contract', err);
      }
    });

    app.get('/api/campaigns/:id/sample-io', async (req, res) => {
      const id = parseId(req.params.id);
      const path = id !== null ? spec?.samples[String(id)] : undefined;
      if (!path) { res.status(404).json({ error: 'No sample IO for this campaign' }); return; }
      try {
        const r = await dbxFetch(filesUrl(path));
        if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
        res.send(Buffer.from(await r.arrayBuffer()));
      } catch (err) {
        fail(res, 'Download sample IO', err);
      }
    });
  });
}
