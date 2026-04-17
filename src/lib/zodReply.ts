import type { FastifyReply } from "fastify";
import { prettifyError } from "zod";
import type { ZodError } from "zod";

/**
 * Canonical JSON error body sent by pulsevault routes. Keep this shape stable
 * across every error path (validation, not-found, send failures, etc.) so
 * clients can pattern-match on a single response envelope.
 */
export type PulseVaultErrorBody = {
  ok: false;
  error: string;
};

export function pulseVaultError(error: string): PulseVaultErrorBody {
  return { ok: false, error };
}

export function replyWithZodError(
  reply: FastifyReply,
  error: ZodError,
  statusCode = 400,
) {
  return reply.code(statusCode).send(pulseVaultError(prettifyError(error)));
}
