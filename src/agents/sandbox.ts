/**
 * Sandbox configuration and lifecycle management.
 *
 * ## Default isolation
 *
 * By default, agent tool execution runs on the host without Docker sandboxing.
 * When `sandbox.enabled` is true in the config, agent bash commands execute
 * inside a Docker container with configurable resource limits.
 *
 * For production SaaS deployments, enable sandboxing to isolate tenant workloads:
 * - Set `sandbox.enabled: true` in config
 * - Use per-tenant workspace directories to prevent cross-tenant filesystem access
 * - Configure resource limits (CPU, memory) via `sandbox.docker` settings
 * - The sandbox image defaults to `DEFAULT_SANDBOX_IMAGE` (see constants.ts)
 */
export {
  resolveSandboxBrowserConfig,
  resolveSandboxConfigForAgent,
  resolveSandboxDockerConfig,
  resolveSandboxPruneConfig,
  resolveSandboxScope,
} from "./sandbox/config.js";
export {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
} from "./sandbox/constants.js";
export { ensureSandboxWorkspaceForSession, resolveSandboxContext } from "./sandbox/context.js";

export { buildSandboxCreateArgs } from "./sandbox/docker.js";
export {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "./sandbox/manage.js";
export {
  formatSandboxToolPolicyBlockedMessage,
  resolveSandboxRuntimeStatus,
} from "./sandbox/runtime-status.js";

export { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";

export type {
  SandboxBrowserConfig,
  SandboxBrowserContext,
  SandboxConfig,
  SandboxContext,
  SandboxDockerConfig,
  SandboxPruneConfig,
  SandboxScope,
  SandboxToolPolicy,
  SandboxToolPolicyResolved,
  SandboxToolPolicySource,
  SandboxWorkspaceAccess,
  SandboxWorkspaceInfo,
} from "./sandbox/types.js";
