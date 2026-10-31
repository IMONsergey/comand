import { z } from 'zod';

export const discoveryInputSchema = z
  .object({
    deviceId: z.string().min(1).max(100),
    query: z.string().trim().max(200).default(''),
    path: z.string().max(4096).optional(),
  })
  .strict();
export type DiscoveryInput = z.input<typeof discoveryInputSchema>;
export const discoveryResultSchema = z
  .object({
    roots: z.array(z.string().max(4096)).max(32),
    candidates: z
      .array(
        z
          .object({
            root: z.string().min(1).max(4096),
            name: z.string().min(1).max(200),
            markers: z.array(z.string().max(80)).max(20),
          })
          .strict(),
      )
      .max(100),
    visited: z.number().int().min(0).max(5000),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(4200)).max(32),
  })
  .strict();
export type DiscoveryResult = z.infer<typeof discoveryResultSchema>;
export interface Discovery {
  id: string;
  deviceId: string;
  query: string;
  path?: string;
  status: 'queued' | 'succeeded' | 'failed' | 'expired';
  createdAt: string;
  expiresAt: string;
  result?: DiscoveryResult;
  error?: string;
}
