import { Card, CardHead, Alert } from '../components/ui.tsx';
import type { Session } from '../App.tsx';

export function SettingsPage({ session }: { session: Session }) {
  const { ai, limits } = session.meta;

  return (
    <>
      <div className="topbar">
        <h1>Settings</h1>
      </div>
      <div className="content stack loose">
        <Card>
          <CardHead title="Account" />
          <div className="card-body">
            <table className="data">
              <tbody>
                <tr>
                  <td className="dim">Name</td>
                  <td>{session.user.name}</td>
                </tr>
                <tr>
                  <td className="dim">Email</td>
                  <td>{session.user.email}</td>
                </tr>
                <tr>
                  <td className="dim">Role</td>
                  <td>{session.user.role}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHead title="AI provider" subtitle="Configured on the server, not in the browser." />
          <div className="card-body stack">
            {ai.offline ? (
              <Alert tone="warn">
                <span>
                  <strong>Offline mode.</strong> No API key is configured for <code>{ai.configured}</code>, so the
                  deterministic local provider is in use. Everything works end to end, but elaboration is generic.
                </span>
              </Alert>
            ) : (
              <Alert tone="ok">
                Connected to <strong>{ai.name}</strong>.
              </Alert>
            )}

            <table className="data">
              <tbody>
                <tr>
                  <td className="dim">Active provider</td>
                  <td>{ai.name}</td>
                </tr>
                <tr>
                  <td className="dim">Configured provider</td>
                  <td>{ai.configured}</td>
                </tr>
                <tr>
                  <td className="dim">Reasoning model</td>
                  <td className="mono tiny">{ai.models.reasoning}</td>
                </tr>
                <tr>
                  <td className="dim">Fast model</td>
                  <td className="mono tiny">{ai.models.fast}</td>
                </tr>
                <tr>
                  <td className="dim">Vision model</td>
                  <td className="mono tiny">{ai.models.vision}</td>
                </tr>
              </tbody>
            </table>

            <div className="stack tight">
              <span className="label">To change provider or models</span>
              <pre className="code">{`# .env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-...
AI_MODEL_REASONING=gpt-5
AI_MODEL_FAST=gpt-5-mini
AI_MODEL_VISION=gpt-5-mini`}</pre>
              <p className="tiny dim">
                Keys are read from the server environment and are never sent to the browser. Restart the server
                after changing them.
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <CardHead title="Limits" />
          <div className="card-body">
            <table className="data">
              <tbody>
                <tr>
                  <td className="dim">Maximum upload size</td>
                  <td>{Math.round(limits.maxUploadBytes / (1024 * 1024))} MB</td>
                </tr>
                <tr>
                  <td className="dim">Files per project</td>
                  <td>{limits.maxUploadsPerProject}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
