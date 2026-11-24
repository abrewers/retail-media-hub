// Ask Genie: full chat over the governed metric views, with the demo's "why" questions one click away.
import { useState } from 'react';
import { GENIE_PROMPT_GROUPS } from '../config/branding';
import { useAppConfig } from '../lib/config';
import { GenieChat } from '../components/GeniePanel';

function NotSetUp() {
  return (
    <div className="ox-panel" style={{ maxWidth: 620, margin: '48px auto', textAlign: 'center' }}>
      <h2 className="ox-h3">Genie isn&apos;t set up yet</h2>
      <p className="ox-muted">Run the setup job (<code>databricks bundle run setup</code>), then restart the app (<code>databricks bundle run app</code>). See README.md.</p>
    </div>
  );
}

export function GeniePage() {
  const config = useAppConfig();
  const [question, setQuestion] = useState<string | undefined>(undefined);
  if (config.data && !config.data.genieEnabled) return <NotSetUp />;
  return (
    <>
      <div className="ox-page-h">
        <div><h1 className="ox-h1">Ask Genie</h1><p className="ox-muted">Plain-English answers from the governed metric views, with the SQL behind them.</p></div>
      </div>
      <div className="ox-genie">
        <div className="ox-panel ox-genie-chat"><GenieChat initialQuestion={question} /></div>
        <aside className="ox-genie-qs">
          {GENIE_PROMPT_GROUPS.map((g) => (
            <div key={g.group} className="ox-stack" style={{ gap: 8 }}>
              <div className="ox-q-group">{g.group}</div>
              {g.prompts.map((p) => (
                <button key={p.label} type="button" className="ox-q" onClick={() => setQuestion(p.question)}>
                  <span className="ox-tag">{g.group === 'Why' ? 'Why' : 'Ask'}</span>{p.question}
                </button>
              ))}
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}
