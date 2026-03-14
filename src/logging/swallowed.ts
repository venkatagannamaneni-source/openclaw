import { getLogger } from "./logger.js";

/**
 * Log a swallowed error at debug level.
 *
 * Use in catch blocks where the error is intentionally ignored (best-effort
 * operations, fallback chains, cleanup paths, etc.) but should still be
 * traceable in production logs.
 *
 * Safe to call from any context: if the logger itself fails the error is
 * silently discarded to avoid cascading failures.
 */
export function swallowed(context: string, err: unknown): void {
  try {
    getLogger().debug({ err, swallowed: true }, context);
  } catch {
    // Logger itself may fail; never re-throw from a swallowed-error handler.
  }
}
