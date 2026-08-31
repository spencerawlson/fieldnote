import { useState } from 'react';
import { api } from '../../lib/api.ts';
import { Button } from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

interface Turn {
  question: string;
  answer: string;
  sources: { type: string; id: string; title: string }[];
}

const SUGGESTIONS = [
  'Find gaps in my documentation',
  'Explain the DNS configuration',
  'What would you change about this project?',
  'Which screenshots show the problem?',
  'What am I most likely to be asked?',
];

/**
 * The in-project assistant.
 *
 * It already knows the project — the user never pastes context into it. Answers
 * cite the records they came from, and it says so when the project cannot
 * answer rather than filling the gap.
 */
export function AssistantDrawer({ ctx, onClose }: { ctx: WorkspaceContext; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setQuestion('');
    try {
      const response = await api.post<{ answer: string; sources: Turn['sources'] }>(
        `/api/projects/${ctx.projectId}/ai/ask`,
        { question: text },
      );
      setTurns((current) => [...current, { question: text, answer: response.answer, sources: response.sources }]);
    } catch (error) {
      ctx.toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="drawer" aria-label="Project assistant">
      <div className="drawer-head">
        <div>
          <h3>Ask about this project</h3>
          <div className="tiny dim">Answers come from your steps, evidence and problems.</div>
        </div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="small" onClick={onClose} aria-label="Close">
          &#10005;
        </Button>
      </div>

      <div className="drawer-body">
        {turns.length === 0 ? (
          <div className="stack">
            <p className="small muted">
              This assistant has your project loaded. Ask it about a step, a screenshot, or what your
              documentation is missing.
            </p>
            <div className="chips">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} className="chip" onClick={() => void ask(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="assistant-log">
            {turns.map((turn, index) => (
              <div key={index} className="stack tight">
                <div className="assistant-msg you">
                  <div className="who">You</div>
                  <div className="body">{turn.question}</div>
                </div>
                <div className="assistant-msg">
                  <div className="who">Fieldnote</div>
                  <div className="body">{turn.answer}</div>
                  {turn.sources.length > 0 ? (
                    <div className="row wrap" style={{ gap: '0.25rem', marginTop: '0.5rem' }}>
                      {turn.sources.map((source) => (
                        <span key={source.id} className="badge">
                          {source.type}: {source.title}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="row muted small">
                <span className="spinner" /> Thinking&hellip;
              </div>
            ) : null}
          </div>
        )}
      </div>

      <div className="drawer-foot">
        <form
          className="row"
          style={{ gap: '0.4rem' }}
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <input
            className="input"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about this project&hellip;"
            disabled={busy}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!question.trim()}>
            Ask
          </Button>
        </form>
      </div>
    </aside>
  );
}
