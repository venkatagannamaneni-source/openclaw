import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTrace = vi.fn();
const mockDebug = vi.fn();

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    trace: mockTrace,
    debug: mockDebug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
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
    const customLogger = { trace: customTrace } as unknown as Parameters<typeof bestEffortCatch>[1];
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
    // Should not throw — subsystem string creates a logger via cache
    expect(mockTrace).toHaveBeenCalledTimes(1);
  });
});

describe("bestEffortCatchDebug", () => {
  it("logs at debug level", () => {
    const handler = bestEffortCatchDebug("config reload");
    handler(new Error("EACCES"));

    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining("config reload"));
  });
});
