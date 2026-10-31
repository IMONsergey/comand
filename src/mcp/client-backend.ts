import type { ComandBackend } from './tools.js';
import type { Job, Device, Project, LogChunk } from '../shared/protocol.js';

/** REST-backed stdio MCP allows private local tools/tunnels without exposing the hub. */
export function remoteBackend(url: string, token: string): ComandBackend {
  const base = new URL(url);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/')
    throw Error('Hub URL must be an origin');
  if (
    base.protocol !== 'https:' &&
    !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
    throw Error('Remote hubs require HTTPS');
  const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(new URL(path, base), {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    const result = (await response.json()) as T & { error?: string };
    if (!response.ok) throw Error(result.error || `Comand HTTP ${response.status}`);
    return result;
  };
  return {
    listDevices: () => request<Device[]>('/api/devices'),
    listProjects: () => request<Project[]>('/api/projects'),
    getProject: async (id) => (await request<Project[]>('/api/projects')).find((p) => p.id === id),
    createProject: (input) => request<Project>('/api/projects', 'POST', input),
    updateProject: (id, input) =>
      request<Project>(`/api/projects/${encodeURIComponent(id)}`, 'PATCH', input),
    listJobs: async (limit = 200) => (await request<Job[]>('/api/jobs')).slice(0, limit),
    getJob: (id) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`),
    createJob: (input) => request<Job>('/api/jobs', 'POST', input),
    cancelJob: (id) => request<Job>(`/api/jobs/${encodeURIComponent(id)}/cancel`, 'POST', {}),
    getLogs: (id, offset = 0, limit = 65_536) =>
      request<LogChunk>(`/api/jobs/${encodeURIComponent(id)}/logs?offset=${offset}&limit=${limit}`),
  };
}
