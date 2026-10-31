import { z } from 'zod';

export const VERSION = '0.4.0';
export const MAX_LOG_CHUNK = 64 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const operationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('command'),
      command: z.string().min(1).max(32_768),
      timeoutMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('process.start'),
      command: z.string().min(1).max(32_768),
      timeoutMs: z.number().int().min(1000).max(86_400_000).default(3_600_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('process.input'),
      sessionId: z.string().regex(/^ps_[a-f0-9]{64}$/),
      input: z.string().max(65_536),
      closeStdin: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('process.output'),
      sessionId: z.string().regex(/^ps_[a-f0-9]{64}$/),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(65_536).default(16_384),
    })
    .strict(),
  z
    .object({ kind: z.literal('process.stop'), sessionId: z.string().regex(/^ps_[a-f0-9]{64}$/) })
    .strict(),
  z.object({ kind: z.literal('process.list') }).strict(),
  z.object({ kind: z.literal('files.list'), path: z.string().max(4096).default('.') }).strict(),
  z
    .object({
      kind: z.literal('files.read'),
      path: z.string().min(1).max(4096),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_FILE_BYTES).default(65_536),
    })
    .strict(),
  z
    .object({
      kind: z.literal('files.write'),
      path: z.string().min(1).max(4096),
      content: z.string().max(MAX_FILE_BYTES),
      expectedHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      createOnly: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('files.search'),
      path: z.string().max(4096).default('.'),
      query: z.string().min(1).max(512),
      maxResults: z.number().int().min(1).max(200).default(50),
    })
    .strict(),
  z.object({ kind: z.literal('files.mkdir'), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      kind: z.literal('files.move'),
      from: z.string().min(1).max(4096),
      to: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal('browser.inspect'),
      url: z.string().url().max(4096),
      width: z.number().int().min(320).max(1920).default(1440),
      height: z.number().int().min(320).max(1600).default(1000),
      screenshot: z.boolean().default(true),
    })
    .strict(),
]);
export type Operation = z.infer<typeof operationSchema>;
export const jobStates = [
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'uncertain',
] as const;
export type JobState = (typeof jobStates)[number];
export const terminalStates = new Set<JobState>(['succeeded', 'failed', 'cancelled']);
export const createJobSchema = z
  .object({
    projectId: z.string().min(1).max(100),
    operation: operationSchema,
    idempotencyKey: z.string().min(8).max(200),
  })
  .strict();
export type CreateJobInput = z.infer<typeof createJobSchema>;

export interface Device {
  projectDiscovery?: boolean;
  id: string;
  name: string;
  platform: string;
  roots: string[];
  allowShell: boolean;
  allowBrowser: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  online: boolean;
  version: string;
}
export interface Project {
  id: string;
  deviceId: string;
  name: string;
  root: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}
export interface Job {
  id: string;
  deviceId: string;
  projectId: string;
  operation: Operation;
  idempotencyKey: string;
  status: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  exitCode: number | null;
  error: string | null;
  result: unknown;
  logBytes: number;
}
export interface Dispatch {
  job: Job;
  project: Project;
}
export interface JobUpdate {
  jobId: string;
  status: JobState;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  error?: string | null;
  result?: unknown;
  log?: { offset: number; data: string };
}
export interface LogChunk {
  text: string;
  nextOffset: number;
  hasMore: boolean;
}
export interface Pairing {
  id: string;
  code: string;
  expiresAt: string;
  /** Stable account namespace for installer paths; never an authorization credential. */
  installationProfile?: string;
}
export interface PairingStatus {
  expiresAt: string;
  device: Device | null;
}
export interface AgentEnrollment {
  pairingCode: string;
  name: string;
  platform: string;
  roots: string[];
  allowShell: boolean;
  allowBrowser: boolean;
  version: string;
}
export interface AgentCredentials {
  deviceId: string;
  token: string;
}
export interface PollResponse {
  discoveries?: import('./discovery.js').Discovery[];
  jobs: Dispatch[];
  cancellations: string[];
  serverTime: string;
}
export interface Overview {
  version: string;
  devices: Device[];
  projects: Project[];
  jobs: Job[];
  counts: {
    devices: number;
    online: number;
    running: number;
    queued: number;
    succeeded: number;
    failed: number;
    uncertain: number;
  };
}
export interface ApiError {
  error: string;
  code?: string;
}
export interface SessionInfo {
  authenticated: boolean;
  csrfToken?: string;
  user?: AccountUser;
  registrationEnabled?: boolean;
}
export interface AccountUser {
  id: string;
  name: string;
  email: string;
}
export interface AgentConfig {
  hubUrl: string;
  deviceId: string;
  token: string;
  name: string;
  roots: string[];
  allowShell: boolean;
  allowBrowser: boolean;
  dataDir: string;
  pollMs: number;
  maxConcurrent: number;
}
