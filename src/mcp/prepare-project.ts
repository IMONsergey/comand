import path from 'node:path';
import { z } from 'zod';
import type { ComandBackend } from './tools.js';
import type { Project } from '../shared/protocol.js';

export const prepareProjectSchema = z
  .object({
    query: z.string().trim().max(200).default(''),
    deviceId: z.string().min(1).max(100).optional(),
    projectId: z.string().min(1).max(100).optional(),
    searchIds: z.array(z.string().min(1).max(100)).max(32).optional(),
  })
  .strict();

/** Agent-facing orchestration. No user wizard, filesystem writes, or execution retries. */
export async function prepareProject(
  backend: ComandBackend,
  raw: z.input<typeof prepareProjectSchema>,
) {
  const input = prepareProjectSchema.parse(raw);
  const devices = (await backend.listDevices()).filter((d) => !d.revokedAt);
  if (input.deviceId && !devices.some((d) => d.id === input.deviceId))
    throw Error('Device not found');
  const ready = async (project: Project) => {
    const device = devices.find((d) => d.id === project.deviceId);
    if (!device) throw Error('Project device is unavailable');
    if (!device.online)
      return {
        status: 'device_offline',
        project,
        next: 'Keep this project; do not silently switch computers.',
      };
    return {
      status: 'ready',
      project,
      recentJobs: (await backend.listJobs(200))
        .filter((j) => j.projectId === project.id)
        .slice(0, 10),
      next: 'Inspect project instructions and files, then perform the user task. Do not ask the user to select this project in the dashboard.',
    };
  };
  if (input.projectId) {
    const project = await backend.getProject(input.projectId);
    if (!project || (input.deviceId && project.deviceId !== input.deviceId))
      throw Error('Project not found on this device');
    return ready(project);
  }
  if (!input.query)
    return {
      status: 'context_needed',
      next: 'Infer a project name from the current task and conversation, or use the ongoing projectId. Do not ask the user to configure a project in the dashboard.',
    };
  const query = input.query.toLocaleLowerCase();
  const matches = (name: string, root: string) =>
    name.toLocaleLowerCase().includes(query) ||
    (query.includes('/') && root.toLocaleLowerCase().includes(query));
  const registered = (await backend.listProjects()).filter(
    (p) => (!input.deviceId || p.deviceId === input.deviceId) && matches(p.name, p.root),
  );
  if (!input.searchIds?.length && registered.length === 1) return ready(registered[0]!);
  if (!input.searchIds?.length && registered.length > 1)
    return {
      status: 'inspect_candidates',
      candidates: registered,
      next: 'Resolve from project_context, task history and the user task yourself. Pass the matching projectId. Ask a short question only if evidence cannot distinguish materially different projects.',
    };
  const scope = devices.filter((d) => !input.deviceId || d.id === input.deviceId);
  if (scope.length > 32)
    return {
      status: 'context_needed',
      next: 'Select the intended device from task context before discovery; more than 32 devices are available.',
    };
  const blocked = scope
    .filter((d) => !d.online || !d.projectDiscovery)
    .map((d) => ({ deviceId: d.id, reason: !d.online ? 'offline' : 'agent_update_required' }));
  if (!input.searchIds?.length) {
    const searches: string[] = [];
    const errors: { deviceId: string; error: string }[] = [];
    for (const device of scope.filter((d) => d.online && d.projectDiscovery)) {
      try {
        searches.push(
          (await backend.createDiscovery({ deviceId: device.id, query: input.query })).id,
        );
      } catch (error) {
        errors.push({ deviceId: device.id, error: (error as Error).message });
      }
    }
    return {
      status: searches.length ? 'searching' : 'unavailable',
      query: input.query,
      searchIds: searches,
      blocked,
      errors,
      next: 'Call prepare_project again with the same query, deviceId and returned searchIds. Do not send the user to search manually.',
    };
  }
  const searches = await Promise.all(input.searchIds.map((id) => backend.getDiscovery(id)));
  if (searches.some((s) => s.query !== input.query || !scope.some((d) => d.id === s.deviceId)))
    throw Error('Search does not match this task/device');
  const missing = scope.filter(
    (d) => d.online && d.projectDiscovery && !searches.some((s) => s.deviceId === d.id),
  );
  if (searches.some((s) => s.status === 'queued'))
    return {
      status: 'searching',
      query: input.query,
      searchIds: input.searchIds,
      next: 'Wait for the same searches; do not create a new search or ask the user to configure folders.',
    };
  const candidates = searches.flatMap(
    (s) =>
      s.result?.candidates
        .filter((c) => c.markers.length > 0 && matches(c.name, c.root))
        .map((c) => ({ ...c, deviceId: s.deviceId, discoveryId: s.id })) ?? [],
  );
  const unique = [
    ...new Map(
      candidates.map((c) => [`${c.deviceId}\0${path.posix.normalize(c.root)}`, c]),
    ).values(),
  ];
  const incomplete =
    blocked.length > 0 ||
    missing.length > 0 ||
    searches.some(
      (s) =>
        s.status !== 'succeeded' ||
        s.expiresAt <= new Date().toISOString() ||
        s.result?.truncated ||
        s.result?.warnings.length,
    );
  if (unique.length === 1 && !incomplete) {
    const c = unique[0]!;
    return ready(await backend.openDiscoveredProject({ discoveryId: c.discoveryId, root: c.root }));
  }
  return {
    status: unique.length ? 'inspect_candidates' : incomplete ? 'incomplete' : 'not_found',
    candidates: unique,
    searches,
    blocked,
    missingDevices: missing.map((d) => d.id),
    next: 'Continue investigating candidates and incomplete scopes yourself with existing tools. Use open_project for the evidenced match without user selection. No matches is not permission to invent a replacement project. Create files only for a genuinely new task; ask only if material ambiguity remains after investigation.',
  };
}
