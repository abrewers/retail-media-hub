// Ask Genie side panel. Opened from anywhere through useGenie().open(question?):
// with a question it is asked straight away, so "Ask why" on a campaign lands on the answer.
import { useEffect, useRef } from 'react';
import { Button, GenieChatInput, GenieChatMessageList, useGenieChat } from '@databricks/appkit-ui/react';
import { GENIE_PANEL_PROMPTS } from '../config/branding';
import { Drawer } from './ox';

export const GENIE_ALIAS = 'default';

export function GenieChat({ initialQuestion, compact }: { initialQuestion?: string; compact?: boolean }) {
  const { messages, status, error, sendMessage, reset, hasPreviousPage, fetchPreviousPage } = useGenieChat({ alias: GENIE_ALIAS });
  const busy = status === 'streaming' || status === 'loading-history';
  const asked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (initialQuestion && asked.current !== initialQuestion && !busy) {
      asked.current = initialQuestion;
      sendMessage(initialQuestion);
    }
  }, [initialQuestion, busy, sendMessage]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: compact ? 0 : 520 }}>
      {messages.length === 0 && status !== 'loading-history' ? (
        <div style={{ padding: compact ? '4px 0' : '16px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="ox-q-group">Try asking</div>
          {GENIE_PANEL_PROMPTS.map((p) => (
            <button key={p.label} type="button" className="ox-q" disabled={busy} onClick={() => sendMessage(p.question)}>
              <span className="ox-tag">Ask</span>{p.question}
            </button>
          ))}
        </div>
      ) : (
        <div className="min-w-0 overflow-x-hidden [&_*]:break-words [&_pre]:whitespace-pre-wrap [&_pre]:max-w-full" style={{ flex: 1, minHeight: 0 }}>
          <GenieChatMessageList messages={messages} status={status} hasPreviousPage={hasPreviousPage} onFetchPreviousPage={fetchPreviousPage} />
        </div>
      )}
      {error && <div className="ox-notice err" style={{ margin: 12 }}>{error}</div>}
      <div style={{ borderTop: '1px solid var(--ox-line)' }}>
        {messages.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '6px 10px 0' }}>
            <Button variant="ghost" size="sm" onClick={() => { asked.current = undefined; reset(); }} className="text-xs text-muted-foreground h-6">New conversation</Button>
          </div>
        )}
        <GenieChatInput onSend={sendMessage} disabled={busy} placeholder="Ask about campaigns, delivery or contracts…" />
      </div>
    </div>
  );
}

export function GeniePanel({ question, onClose }: { question?: string; onClose: () => void }) {
  return (
    <Drawer title="✦ Ask Genie" onClose={onClose} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, margin: '0 -22px -20px', minHeight: 0 }}>
        <GenieChat initialQuestion={question} compact />
      </div>
    </Drawer>
  );
}
