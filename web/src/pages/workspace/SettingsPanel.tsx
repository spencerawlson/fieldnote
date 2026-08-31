import { useEffect, useState } from 'react';
import { api } from '../../lib/api.ts';
import { Alert, Button, Card, CardHead, Field } from '../../components/ui.tsx';
import type { WorkspaceContext } from './ProjectWorkspace.tsx';

interface VersionRecord {
  id: string;
  entityType: string;
  entityId: string;
  revision: number;
  actorType: string;
  reason: string;
  createdAt: string;
}

interface UsageSummary {
  totals: { runs: number; input: number; output: number; cost: number };
  byService: { service: string; runs: number; cost: number }[];
}

interface SecretFinding {
  id: string;
  detector: string;
  severity: string;
  preview: string;
  acknowledged: boolean;
}

export function SettingsPanel({ ctx }: { ctx: WorkspaceContext }) {
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [findings, setFindings] = useState<SecretFinding[]>([]);
  const [tone, setTone] = useState(ctx.project.tone);
  const [audience, setAudience] = useState(ctx.project.audience);
  const [depth, setDepth] = useState(ctx.project.elaborationDepth);
  const [status, setStatus] = useState(ctx.project.status);

  useEffect(() => {
    void Promise.all([
      api.get<{ versions: VersionRecord[] }>(`/api/projects/${ctx.projectId}/versions`),
      api.get<UsageSummary>(`/api/projects/${ctx.projectId}/usage`),
      api.get<{ findings: SecretFinding[] }>(`/api/projects/${ctx.projectId}/privacy`),
    ])
      .then(([versionResponse, usageResponse, privacyResponse]) => {
        setVersions(versionResponse.versions);
        setUsage(usageResponse);
        setFindings(privacyResponse.findings);
      })
      .catch(() => undefined);
  }, [ctx.projectId]);

  const save = async () => {
    try {
      await api.patch(`/api/projects/${ctx.projectId}`, { tone, audience, elaborationDepth: depth, status });
      await ctx.reload();
      ctx.toast.show('Project settings saved.', 'ok');
    } catch (error) {
      ctx.toast.error(error);
    }
  };

  return (
    <div className="grid two" style={{ alignItems: 'start' }}>
      <div className="stack">
        <Card>
          <CardHead title="Generation defaults" subtitle="Applied to new reports, decks and elaboration." />
          <div className="card-body stack">
            <Field label="Tone">
              <select className="select" value={tone} onChange={(e) => setTone(e.target.value)} disabled={!ctx.canEdit}>
                {ctx.session.meta.tones.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Audience">
              <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)} disabled={!ctx.canEdit}>
                {ctx.session.meta.audiences.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Elaboration depth"
              hint="Changing this does not rewrite existing content until you regenerate."
            >
              <select className="select" value={depth} onChange={(e) => setDepth(Number(e.target.value))} disabled={!ctx.canEdit}>
                {ctx.session.meta.depths.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.value} — {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} disabled={!ctx.canEdit}>
                {['draft', 'active', 'complete', 'archived'].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            {ctx.canEdit ? (
              <Button variant="primary" onClick={() => void save()}>
                Save settings
              </Button>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHead title="Privacy" subtitle="Possible secrets found in evidence text." />
          <div className="card-body stack tight">
            {findings.length === 0 ? (
              <p className="small dim">Nothing flagged. Extracted text is scanned on every upload.</p>
            ) : (
              <>
                <Alert tone="warn">
                  Redacted copies are what reach the AI and your exports. The originals stay on this server.
                </Alert>
                <table className="data">
                  <tbody>
                    {findings.map((finding) => (
                      <tr key={finding.id}>
                        <td>
                          <span className={`badge ${finding.severity === 'high' ? 'danger' : 'warn'}`}>{finding.detector}</span>
                        </td>
                        <td className="mono tiny">{finding.preview}</td>
                        <td style={{ textAlign: 'right' }}>
                          {!finding.acknowledged && ctx.canEdit ? (
                            <Button
                              size="small"
                              variant="ghost"
                              onClick={async () => {
                                await api.post(`/api/projects/${ctx.projectId}/privacy/${finding.id}/acknowledge`);
                                setFindings((current) =>
                                  current.map((f) => (f.id === finding.id ? { ...f, acknowledged: true } : f)),
                                );
                              }}
                            >
                              Acknowledge
                            </Button>
                          ) : (
                            <span className="tiny dim">acknowledged</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="stack">
        <Card>
          <CardHead title="AI usage" subtitle="Cost estimates for this project." />
          <div className="card-body">
            {usage ? (
              <table className="data">
                <tbody>
                  <tr>
                    <td className="dim">Calls</td>
                    <td style={{ textAlign: 'right' }}>{usage.totals.runs}</td>
                  </tr>
                  <tr>
                    <td className="dim">Input tokens</td>
                    <td style={{ textAlign: 'right' }}>{usage.totals.input.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="dim">Output tokens</td>
                    <td style={{ textAlign: 'right' }}>{usage.totals.output.toLocaleString()}</td>
                  </tr>
                  <tr>
                    <td className="dim">Estimated cost</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      ${(usage.totals.cost / 100).toFixed(3)}
                    </td>
                  </tr>
                  {usage.byService.map((service) => (
                    <tr key={service.service}>
                      <td className="tiny dim" style={{ paddingLeft: '1rem' }}>{service.service}</td>
                      <td className="tiny dim" style={{ textAlign: 'right' }}>
                        {service.runs} · ${(service.cost / 100).toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="small dim">No AI usage recorded yet.</p>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="History" subtitle="Every edit keeps a snapshot." />
          <div className="card-body">
            {versions.length === 0 ? (
              <p className="small dim">No changes recorded yet.</p>
            ) : (
              <table className="data">
                <tbody>
                  {versions.slice(0, 25).map((version) => (
                    <tr key={version.id}>
                      <td className="tiny">
                        <span className="badge">{version.entityType}</span> r{version.revision}
                      </td>
                      <td className="tiny muted">{version.reason || 'edit'}</td>
                      <td className="tiny dim nowrap" style={{ textAlign: 'right' }}>
                        {new Date(version.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
