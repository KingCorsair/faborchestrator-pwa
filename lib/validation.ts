/**
 * Zod schemas for API request input.
 *
 * Same convention as `claudeai_athena/lib/validation.ts`: schemas live together
 * rather than beside the routes, so what the API accepts is one file someone
 * can read end to end.
 */

import { z } from "zod";

/**
 * A phone's proof for FabOrchestrator's approved devices (its Admin → Devices):
 * the device id, a challenge from FO's `/api/auth/device-challenge`, and the
 * device's signature over it (`lib/fo-device-key.ts`). Passed to FO untouched;
 * FO checks it.
 */
export const FoDeviceProofSchema = z
  .object({
    deviceId: z.string().min(1).max(64),
    challenge: z.string().min(1).max(200),
    signature: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  })
  .strict();

export const LoginSchema = z.object({
  email: z.string().min(1, "Email is required").max(255),
  password: z.string().min(1, "Password is required").max(128),
  /** Sent when this phone holds a FabOrchestrator device key; FO requires it while its device approval is on. */
  device: FoDeviceProofSchema.optional(),
});

/**
 * The most `/api/pwa/auth/login` will read: 16 KiB, the plan's value for every
 * `/api/pwa/auth/*` body (RP1 body classes, RP10-B part 1). The longest legal
 * credentials are about 3 KB even with every character JSON-escaped, so nothing
 * a real sign-in sends comes near it.
 */
export const LOGIN_BODY_LIMIT = 16 * 1024;
