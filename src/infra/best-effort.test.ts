import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTrace = vi.fn();
const mockDebug = vi.fn();
const mockCreateSubsystemLogger = vi.fn(() => ({
  trace: mockTrace,
  debug: mockDebug,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  isEnabled: () => true,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: mockCreateSubsystemLogger,
}));

// Import after mock setup
const { bestEffortCatch, bestEffortCatchDebug } = await import("./best-effort.js");

beforeEach(() => {
  mockTrace.mockClear();
  mockDebug.mockClear();
});

describe("bestEffortCatch", () => {
  it("logs at trace level with context and error message", () => {
    const handler = bestEffortCatch("close file handle");
    handler(new Error("EBADF: bad file descriptor"));

    expect(mockTrace).toHaveBeenCalledWith(expect.stringContaining("close file handle"));
    expect(mockTrace).toHaveBeenCalledWith(expect.stringContaining("EBADF"));
  });

  it("handles non-Error values", () => {
    const handler = bestEffortCatch("parse json");
    handler("unexpected token");

    expect(mockTrace).toHaveBeenCalledWith(expect.stringContaining("unexpected token"));
  });

  it("accepts a custom SubsystemLogger", () => {
    const customTrace = vi.fn();
    const customLogger = {
      trace: customTrace,
      isEnabled: () => true,
    } as unknown as Parameters<typeof bestEffortCatch>[1];
    const handler = bestEffortCatch("custom op", customLogger);
    handler(new Error("fail"));

    expect(customTrace).toHaveBeenCalledWith(expect.stringContaining("custom op"));
  });

  it("handles null and undefined error values", () => {
    const handler = bestEffortCatch("null error");
    handler(null);
    expect(mockTrace).toHaveBeenCalledTimes(1);
    expect(mockTrace).toHaveBeenCalledWith(expect.stringContaining("null error"));

    mockTrace.mockClear();
    handler(undefined);
    expect(mockTrace).toHaveBeenCalledTimes(1);
  });

  it("accepts a subsystem name string", () => {
    const handler = bestEffortCatch("op context", "my-subsystem");
    handler(new Error("test"));
    expect(mockTrace).toHaveBeenCalledTimes(1);
  });

  it("caches loggers by subsystem name", () => {
    const callsBefore = mockCreateSubsystemLogger.mock.calls.length;
    bestEffortCatch("a", "cached-subsystem")(new Error("1"));
    bestEffortCatch("b", "cached-subsystem")(new Error("2"));
    const callsAfter = mockCreateSubsystemLogger.mock.calls.length;
    // Should only create one logger for "cached-subsystem"
    expect(callsAfter - callsBefore).toBe(1);
  });
});

describe("bestEffortCatchDebug", () => {
  it("logs at debug level with context and error message", () => {
    const handler = bestEffortCatchDebug("config reload");
    handler(new Error("EACCES"));

    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining("config reload"));
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("handles non-Error values at debug level", () => {
    bestEffortCatchDebug("queue ack")("connection reset");
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
  });

  it("accepts a custom SubsystemLogger", () => {
    const customDebug = vi.fn();
    const customLogger = {
      debug: customDebug,
      isEnabled: () => true,
    } as unknown as Parameters<typeof bestEffortCatchDebug>[1];
    bestEffortCatchDebug("stop service", customLogger)(new Error("timeout"));
    expect(customDebug).toHaveBeenCalledWith(expect.stringContaining("stop service"));
  });
});
