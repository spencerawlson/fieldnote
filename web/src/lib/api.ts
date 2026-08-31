/**
 * API client.
 *
 * One place that knows about the CSRF header, the error envelope and the SSE
 * job stream. Everything else in the UI works with plain typed objects.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (!isForm && body !== undefined) headers['content-type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['x-fieldnote-csrf'] = csrfToken;

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: isForm ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError(response.status, 'http_error', response.statusText);
    return (await response.text()) as T;
  }

  const payload = await response.json();
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'error', error.message ?? 'Request failed', error.details);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, files: File[]) => {
    const form = new FormData();
    for (const file of files) form.append('file', file, file.name);
    return request<T>('POST', path, form, true);
  },
};

/**
 * Subscribes to job progress. Returns an unsubscribe function.
 * EventSource reconnects on its own, so the UI does not implement retry.
 */
export function subscribeToJobs(
  projectId: string,
  onJob: (job: JobRecord) => void,
  onSnapshot?: (jobs: JobRecord[]) => void,
): () => void {
  const source = new EventSource(`/api/projects/${projectId}/jobs/stream`, { withCredentials: true });
  source.addEventListener('job', (event) => {
    try {
      onJob(JSON.parse((event as MessageEvent).data));
    } catch {
      /* ignore malformed frames */
    }
  });
  source.addEventListener('snapshot', (event) => {
    try {
      onSnapshot?.(JSON.parse((event as MessageEvent).data).jobs);
    } catch {
      /* ignore */
    }
  });
  return () => source.close();
}

// --- shared types ---------------------------------------------------------

export type Provenance = 'USER_FACT' | 'EVIDENCE' | 'AI_EXPLANATION' | 'AI_INFERENCE' | 'AI_RECOMMENDATION';
export type Confidence = 'high' | 'medium' | 'low';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface Project {
  id: string;
  title: string;
  summary: string | null;
  objective: string | null;
  scope: string | null;
  requirements: string | null;
  environment: string | null;
  architecture: string | null;
  conclusion: string | null;
  status: 'draft' | 'active' | 'complete' | 'archived';
  domain: string | null;
  elaborationDepth: number;
  tone: string;
  audience: string;
  voice: string;
  createdAt: string;
  updatedAt: string;
  counts?: Record<string, number>;
  completeness?: number;
}

export interface Claim {
  id: string;
  subjectType: string;
  subjectId: string;
  slot: string;
  provenance: Provenance;
  confidence: Confidence;
  text: string;
  supports: { type: string; id: string }[];
  editedByUser: boolean;
  accepted: boolean | null;
  position: number;
}

export interface Step {
  id: string;
  projectId: string;
  position: number;
  title: string;
  userDescription: string;
  category: string;
  status: string;
  occurredAt: string | null;
  configuration: string | null;
  expectedResult: string | null;
  actualResult: string | null;
  validation: string | null;
  aiState: 'pending' | 'elaborated' | 'stale' | 'failed';
  aiConfidence: Confidence | null;
  claims: Claim[];
  commands: Command[];
  evidenceLinks: EvidenceLink[];
}

export interface Command {
  id: string;
  stepId: string | null;
  language: string;
  content: string;
  output: string | null;
  explanation: string | null;
}

export interface EvidenceLink {
  id: string;
  evidenceId: string;
  targetType: string;
  targetId: string;
  role: string;
  origin: 'user' | 'ai';
  confidence: Confidence | null;
  note: string | null;
}

export interface Evidence {
  id: string;
  projectId: string;
  fileId: string | null;
  kind: string;
  title: string;
  description: string | null;
  caption: string | null;
  reviewState: 'unreviewed' | 'ai-analyzed' | 'user-confirmed' | 'user-corrected' | 'rejected';
  confidence: Confidence | null;
  sensitive: boolean;
  file?: { id: string; mimeType: string; byteSize: number; width: number | null; height: number | null; hasThumbnail: boolean } | null;
  analysis?: ImageAnalysis | null;
  ocr?: { chars: number; preview: string; redacted: boolean } | null;
  links: EvidenceLink[];
}

export interface ImageAnalysis {
  description: string;
  detectedApp: string | null;
  detectedOs: string | null;
  observations: { text: string; confidence: Confidence }[];
  entities: Record<string, string[]>;
  suggested: Record<string, string | null>;
  confidence: Confidence;
}

export interface Problem {
  id: string;
  title: string;
  stepId: string | null;
  symptoms: string | null;
  impact: string | null;
  hypothesis: string | null;
  rootCause: string | null;
  rootCauseProvenance: Provenance;
  rootCauseConfidence: Confidence | null;
  status: string;
  claims: Claim[];
  investigations: { id: string; action: string; finding: string | null; tool: string | null }[];
  resolutions: { id: string; description: string; validation: string | null; validated: boolean }[];
  evidenceLinks: EvidenceLink[];
}

export interface Insight {
  id: string;
  kind: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  suggestion: string | null;
  targets: { type: string; id: string }[];
  confidence: Confidence;
  state: string;
  scope: string;
}

export interface JobRecord {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  progressTotal: number;
  message: string;
  error: string | null;
  result: unknown;
}

export interface Completeness {
  percent: number;
  note: string;
  missing: string[];
  categories: { key: string; label: string; score: number; weight: number; missing: string[] }[];
}

export interface ReportSummary {
  id: string;
  title: string;
  templateKey: string;
  theme: string;
  status: string;
  version: number;
  stale: boolean;
  sections: number;
  depth: number;
  tone: string;
  audience: string;
  generatedAt: string | null;
}

export interface ReportSection {
  id: string;
  key: string;
  heading: string;
  blocks: ReportBlock[];
  editedByUser: boolean;
}

export type ReportBlock =
  | { type: 'paragraph'; text: string; provenance?: Provenance }
  | { type: 'heading'; level: number; text: string }
  | { type: 'bullets'; items: string[]; ordered?: boolean }
  | { type: 'procedure'; items: { text: string; detail?: string }[] }
  | { type: 'code'; language: string; content: string; caption?: string }
  | { type: 'table'; caption?: string; headers: string[]; rows: string[][] }
  | { type: 'figure'; evidenceId: string; caption: string; number?: number }
  | { type: 'callout'; variant: 'note' | 'warning' | 'inference' | 'recommendation'; text: string }
  | { type: 'diagram'; title?: string; ascii: string; caption?: string }
  | { type: 'reference-list'; items: { label: string; url?: string; detail?: string }[] };

export interface PresentationSummary {
  id: string;
  title: string;
  templateKey: string;
  status: string;
  audience: string;
  slideTarget: number;
  theme: string;
  stale: boolean;
  slides: number;
  generatedAt: string | null;
}

export interface Slide {
  id: string;
  position: number;
  layout: string;
  title: string;
  subtitle: string | null;
  bullets: string[];
  body: Record<string, unknown>;
  evidenceIds: string[];
  speakerNotes: string;
  editedByUser: boolean;
}

export interface QaItem {
  question: { id: string; text: string; category: string; level: string; difficulty: number };
  answer?: {
    id: string;
    text: string;
    grounding: { type: string; id: string }[];
    generalKnowledge: string | null;
    confidence: Confidence;
  };
}

export interface TemplateInfo {
  key: string;
  name: string;
  description: string;
  defaultTone: string;
  defaultAudience: string;
  sections?: { key: string; heading: string; derived: boolean }[];
  slides?: { key: string; title: string }[];
  slideCount?: number;
}

export interface Meta {
  categories: string[];
  tones: string[];
  audiences: string[];
  voices: { value: string; label: string }[];
  depths: { value: number; label: string }[];
  ai: { name: string; configured: string; offline: boolean; models: Record<string, string> };
  limits: { maxUploadBytes: number; maxUploadsPerProject: number };
}
