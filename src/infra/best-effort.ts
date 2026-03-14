import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { formatErrorMessage } from "./errors.js";

const cache = new Map<string, SubsystemLogger>();

function getOrCreateLogger(subsystem: string): SubsystemLogger {
  let logger = cache.get(subsystem);
  if (!logger) {
    logger = createSubsystemLogger(subsystem);
    cache.set(subsystem, logger);
  }
  return logger;
}

/** Trace-level catch handler for best-effort operations. */
export function bestEffortCatch(
  context: string,
  loggerOrSubsystem?: SubsystemLogger | string,
): (err: unknown) => void {
  return (err: unknown) => {
    const log =
      typeof loggerOrSubsystem === "object"
        ? loggerOrSubsystem
        : getOrCreateLogger(loggerOrSubsystem ?? "best-effort");
    log.trace(`${context}: ${formatErrorMessage(err)}`);
  };
}

/** Debug-level catch handler for less-expected failures. */
export function bestEffortCatchDebug(
  context: string,
  loggerOrSubsystem?: SubsystemLogger | string,
): (err: unknown) => void {
  return (err: unknown) => {
    const log =
      typeof loggerOrSubsystem === "object"
        ? loggerOrSubsystem
        : getOrCreateLogger(loggerOrSubsystem ?? "best-effort");
    log.debug(`${context}: ${formatErrorMessage(err)}`);
  };
}
