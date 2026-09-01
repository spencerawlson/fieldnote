import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  api,
  subscribeToJobs,
  type Completeness,
  type Evidence,
  type Insight,
  type JobRecord,
  type Problem,
  type Project,
  type Step,
} from '../../lib/api.ts';
import { Button, Tabs, useToast } from '../../components/ui.tsx';
import type { Session } from '../../App.tsx';
import { OverviewPanel } from './OverviewPanel.tsx';
import { StepsPanel } from './StepsPanel.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { ProblemsPanel } from './ProblemsPanel.tsx';
import { ReportPanel } from './ReportPanel.tsx';
import { PresentationPanel } from './PresentationPanel.tsx';
import { QAPanel } from './QAPanel.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { AssistantDrawer } from './Assistant.tsx';
import { IntakeModal } from './IntakeModal.tsx';

export type TabKey =
  | 'overview'
  | 'steps'
  | 'evidence'
  | 'problems'
  | 'analysis'
  | 'report'
  | 'presentation'
  | 'qa'
  | 'settings';

export interface WorkspaceData {
  project: Project;
  completeness: Completeness;
  steps: Step[];
  evidence: Evidence[];
  problems: Problem[];
  insights: Insight[];
  role: string;
}

export interface WorkspaceContext extends WorkspaceData {
  projectId: string;
  session: Session;
  reload: () => Promise<void>;
  toast: ReturnType<typeof useToast>;
  canEdit: boolean;
  activeJobs: JobRecord[];
}

export function ProjectWorkspace({ projectId, session }: { projectId: string; session: Session }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeJobs, setActiveJobs] = useState<JobRecord[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const intakeNotes = searchParams.get('intake');

  const reload = useCallback(async () => {
    try {
      const [overview, steps, evidence, problems, insights] = await Promise.all([
        api.get<{ project: Project; role: string; completeness: Completeness }>(`/api/projects/${projectId}`),
        api.get<{ steps: Step[] }>(`/api/projects/${projectId}/steps`),
        api.get<{ evidence: Evidence[] }>(`/api/projects/${projectId}/evidence`),
        api.get<{ problems: Problem[] }>(`/api/projects/${projectId}/problems`),
        api.get<{ insights: Insight[] }>(`/api/projects/${projectId}/insights?state=open`),
      ]);
      setData({
        project: overview.project,
        role: overview.role,
        completeness: overview.completeness,
        steps: steps.steps,
        evidence: evidence.evidence,
        problems: problems.problems,
        insights: insights.insights,
      });
    } catch (error) {
      toast.error(error);
      navigate('/projects');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live job progress. When a job finishes, the workspace refreshes itself so
  // the user never has to reload to see what the AI produced.
  useEffect(() => {
    const unsubscribe = subscribeToJobs(
      projectId,
      (job) => {
        setActiveJobs((current) => {
          const rest = current.filter((j) => j.id !== job.id);
          return job.status === 'queued' || job.status === 'running' ? [...rest, job] : rest;
        });
        if (job.status === 'succeeded') void reload();
        if (job.status === 'failed') toast.show(`${describeJob(job.type)} failed: ${job.error ?? 'unknown error'}`, 'danger');
      },
      (jobs) => setActiveJobs(jobs),
    );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, reload]);

  const context: WorkspaceContext | null = useMemo(
    () =>
      data
        ? {
            ...data,
            projectId,
            session,
            reload,
            toast,
            canEdit: data.role === 'owner' || data.role === 'editor',
            activeJobs,
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, projectId, session, reload, activeJobs],
  );

  if (!context) {
    return (
      <div className="content">
        <div className="row muted">
          <span className="spinner" /> Loading project…
        </div>
      </div>
    );
  }

  const criticalCount = context.insights.filter((i) => i.severity === 'critical').length;

  return (
    <>
      <div className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="crumb">Project</div>
          <h1 className="truncate">{context.project.title}</h1>
        </div>
        <div className="spacer" />
        {activeJobs.length > 0 ? (
          <div className="jobbar">
            <span className="spinner" />
            <span>
              {describeJob(activeJobs[0]!.type)}
              {activeJobs[0]!.message ? ` — ${activeJobs[0]!.message}` : ''}
              {activeJobs[0]!.progressTotal > 0
                ? ` (${activeJobs[0]!.progress}/${activeJobs[0]!.progressTotal})`
                : ''}
            </span>
          </div>
        ) : null}
        <Button onClick={() => setAssistantOpen(true)}>Ask about this project</Button>
        {context.canEdit ? (
          <Button
            onClick={() => {
              searchParams.set('intake', '');
              setSearchParams(searchParams, { replace: false });
            }}
          >
            Add work
          </Button>
        ) : null}
        {context.canEdit ? (
          <Button
            variant="primary"
            disabled={activeJobs.length > 0}
            onClick={async () => {
              try {
                await api.post(`/api/projects/${projectId}/ai/analyze`, { regenerate: false });
                toast.show('Analysis started. Progress appears above.', 'info');
              } catch (error) {
                toast.error(error);
              }
            }}
          >
            Analyse project
          </Button>
        ) : null}
      </div>

      <div className="content wide stack">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'steps', label: 'Steps', count: context.steps.length },
            { key: 'evidence', label: 'Evidence', count: context.evidence.length },
            { key: 'problems', label: 'Problems', count: context.problems.length },
            { key: 'analysis', label: 'AI analysis', count: criticalCount || context.insights.length },
            { key: 'report', label: 'Report' },
            { key: 'presentation', label: 'Presentation' },
            { key: 'qa', label: 'Q&A' },
            { key: 'settings', label: 'Settings' },
          ]}
        />

        {tab === 'overview' ? <OverviewPanel ctx={context} onNavigate={setTab} /> : null}
        {tab === 'steps' ? <StepsPanel ctx={context} /> : null}
        {tab === 'evidence' ? <EvidencePanel ctx={context} /> : null}
        {tab === 'problems' ? <ProblemsPanel ctx={context} /> : null}
        {tab === 'analysis' ? <OverviewPanel ctx={context} onNavigate={setTab} analysisOnly /> : null}
        {tab === 'report' ? <ReportPanel ctx={context} /> : null}
        {tab === 'presentation' ? <PresentationPanel ctx={context} /> : null}
        {tab === 'qa' ? <QAPanel ctx={context} /> : null}
        {tab === 'settings' ? <SettingsPanel ctx={context} /> : null}
      </div>

      {assistantOpen ? <AssistantDrawer ctx={context} onClose={() => setAssistantOpen(false)} /> : null}

      {intakeNotes !== null ? (
        <IntakeModal
          ctx={context}
          initialNotes={intakeNotes}
          onClose={() => {
            searchParams.delete('intake');
            setSearchParams(searchParams, { replace: true });
          }}
        />
      ) : null}

      {toast.node}
    </>
  );
}

export function describeJob(type: string): string {
  switch (type) {
    case 'project.analyze':
      return 'Analysing project';
    case 'project.review':
      return 'Reviewing documentation';
    case 'evidence.analyze':
      return 'Analysing evidence';
    case 'evidence.classify':
      return 'Linking evidence';
    case 'step.elaborate':
      return 'Elaborating step';
    case 'problem.elaborate':
      return 'Analysing problem';
    case 'report.generate':
      return 'Generating report';
    case 'presentation.generate':
      return 'Building presentation';
    case 'presentation.notes':
      return 'Writing speaker notes';
    case 'presentation.review':
      return 'Reviewing presentation';
    case 'qa.generate':
      return 'Preparing questions';
    case 'export.render':
      return 'Rendering export';
    default:
      return type;
  }
}
