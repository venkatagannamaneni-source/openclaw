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

function resolveLogger(loggerOrSubsystem: SubsystemLogger | string | undefined): SubsystemLogger {
  if (loggerOrSubsystem != null && typeof loggerOrSubsystem === "object") {
    return loggerOrSubsystem;
  }
  return getOrCreateLogger(
    typeof loggerOrSubsystem === "string" ? loggerOrSubsystem : "best-effort",
  );
}

function catchAtLevel(
  level: "trace" | "debug",
  context: string,
  loggerOrSubsystem?: SubsystemLogger | string,
): (err: unknown) => void {
  return (err: unknown) => {
    const log = resolveLogger(loggerOrSubsystem);
    // Guard: skip formatErrorMessage + redactSensitiveText when level is disabled.
    if (!log.isEnabled(level)) {
      return;
    }
    log[level](`${context}: ${formatErrorMessage(err)}`);
  };
}

/** Trace-level catch handler for best-effort operations. */
export function bestEffortCatch(
  context: string,
  loggerOrSubsystem?: SubsystemLogger | string,
): (err: unknown) => void {
  return catchAtLevel("trace", context, loggerOrSubsystem);
}

/** Debug-level catch handler for less-expected failures. */
export function bestEffortCatchDebug(
  context: string,
  loggerOrSubsystem?: SubsystemLogger | string,
): (err: unknown) => void {
  return catchAtLevel("debug", context, loggerOrSubsystem);
}
