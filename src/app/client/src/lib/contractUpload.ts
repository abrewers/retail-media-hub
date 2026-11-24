// Shared upload flow for signed IO PDFs (Campaigns table and the Contract tab).
import { readError } from './api';

export type UploadState = { state: 'uploading' | 'extracting' | 'done' | 'no_terms' | 'failed'; message: string; seconds: number };

export const isBusy = (s: UploadState | undefined) => s?.state === 'uploading' || s?.state === 'extracting';

/** Uploads one PDF, then polls the extraction until it finishes. Never throws: failures come back as state 'failed'. */
export async function uploadContract(campaignId: number, file: File, onProgress: (s: UploadState) => void): Promise<UploadState> {
  const end = (s: UploadState) => { onProgress(s); return s; };
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return end({ state: 'failed', message: 'Choose a PDF file.', seconds: 0 });
  if (file.size > 10 * 1024 * 1024) return end({ state: 'failed', message: 'PDF is larger than 10 MB.', seconds: 0 });
  onProgress({ state: 'uploading', message: 'Uploading…', seconds: 0 });
  try {
    const r = await fetch(`/api/campaigns/${campaignId}/contract?name=${encodeURIComponent(file.name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file,
    });
    if (!r.ok) throw new Error(await readError(r));
    const { jobId } = (await r.json()) as { jobId: string };
    for (;;) {
      await new Promise((res) => setTimeout(res, 2000));
      const p = await fetch(`/api/contract-jobs/${jobId}`);
      if (!p.ok) throw new Error(await readError(p));
      const s = (await p.json()) as UploadState;
      onProgress(s);
      if (s.state !== 'extracting') return s;
    }
  } catch (err) {
    return end({ state: 'failed', message: err instanceof Error ? err.message : String(err), seconds: 0 });
  }
}
