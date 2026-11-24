// Contract tab drop area for a campaign with no signed IO; uses the shared upload flow.
import { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { isBusy, uploadContract, type UploadState } from '../lib/contractUpload';
import { Notice } from './ox';

export function ContractUpload({ campaignId, sample, onDone }: { campaignId: number; sample: boolean; onDone: (msg: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [job, setJob] = useState<UploadState | null>(null);
  const busy = isBusy(job ?? undefined);

  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    const final = await uploadContract(campaignId, file, setJob);
    if (final.state === 'done') onDone(final.message);
  };

  return (
    <div className="ox-stack" style={{ gap: 12 }}>
      <div className="ox-empty" style={{ padding: '8px 0 0' }}>No signed IO on file for this campaign.</div>
      {job && (job.state === 'failed' || job.state === 'no_terms') && <Notice>{job.message}</Notice>}
      <div
        className={`ox-drop ${drag ? 'on' : ''} ${busy ? 'busy' : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Upload signed IO PDF"
        aria-busy={busy}
        onClick={() => { if (!busy) input.current?.click(); }}
        onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files[0]); }}
      >
        <FileUp size={22} aria-hidden="true" />
        {busy && job ? (
          <>
            <b>{job.state === 'uploading' ? 'Uploading…' : `Extracting terms… ${job.seconds > 0 ? `${job.seconds}s` : ''}`}</b>
            <span>Reading the PDF with ai_parse_document and ai_extract. This usually takes 30 to 60 seconds.</span>
          </>
        ) : (
          <>
            <b>Upload the signed IO (PDF)</b>
            <span>Drop it here or click to choose. The make-good terms are read with ai_parse_document and ai_extract, then used by the make-good drawer and Genie.</span>
          </>
        )}
        <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {sample && !busy && (
        <p className="ox-muted ox-small" style={{ margin: 0 }}>
          Demo: <a href={`/api/campaigns/${campaignId}/sample-io`} download>download this campaign&apos;s sample IO</a>, then upload it here.
        </p>
      )}
    </div>
  );
}
