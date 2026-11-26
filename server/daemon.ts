import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const run = promisify(execFile);

const DEFAULT_PORT = "6767";
const RESOLVE_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Turns the daemon's `listen` value into a connectable host:port. Accepts "0.0.0.0:6767",
 * "127.0.0.1:6767" and "[::]:6767"; a wildcard host becomes 127.0.0.1. Returns null for a unix
 * socket, which this plugin cannot reach over the WebSocket transport.
 */
function normalizeEndpoint(listen: string): string | null {
  const match = /^(.*):(\d+)$/.exec(listen.trim());
  if (!match) return null;
  const [, host, port] = match;
  if (!host || host === "0.0.0.0" || host === "*" || host === "[::]" || host === "::") {
    return `127.0.0.1:${port}`;
  }
  return `${host}:${port}`;
}

/**
 * The daemon this plugin runs inside. `PASEO_HOST` is the CLI's own endpoint variable, so it is
 * honoured first when Paseo exports one; otherwise ask the local daemon, then fall back to the
 * default local port. This plugin runs beside its daemon, so loopback is enough.
 */
async function resolveDaemonEndpoint(): Promise<string> {
  const envHost = process.env.PASEO_HOST?.trim();
  if (envHost) {
    const bare = envHost.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
    const fromEnv = normalizeEndpoint(bare);
    if (fromEnv) return fromEnv;
  }
  try {
    const { stdout } = await run("paseo", ["daemon", "status", "--json"], { timeout: RESOLVE_TIMEOUT_MS });
    const fromStatus = normalizeEndpoint(String(JSON.parse(stdout)?.listen ?? ""));
    if (fromStatus) return fromStatus;
  } catch {
    // `paseo` missing from the plugin's PATH, or the daemon listens on a socket.
  }
  return `127.0.0.1:${DEFAULT_PORT}`;
}

/**
 * Imports a provider session as an agent inside the given workspace, then sets its model.
 * `paseo import` cannot choose a workspace and the SDK has no import call, so this uses the daemon client
 * directly (an internal @getpaseo/client path).
 * ponytail: depends on that internal path, so a Paseo release that moves it breaks the import.
 */
export async function importAgent(input: {
  provider: string;
  sessionId: string;
  cwd: string;
  workspaceId?: string;
  modelId: string;
}) {
  const endpoint = await resolveDaemonEndpoint();
  const client = new DaemonClient({
    url: `ws://${endpoint}/ws`,
    clientId: `switch-provider-${Date.now()}`,
    clientType: "cli",
    password: process.env.PASEO_PASSWORD || undefined,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    reconnect: { enabled: false },
  });
  await client.connect();
  try {
    const agent = await client.importAgent({
      provider: input.provider,
      sessionId: input.sessionId,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
    });
    // ponytail: best effort. If this fails the agent still runs on the provider's default model; pick another in the composer.
    await client.setAgentModel(agent.id, input.modelId).catch(() => undefined);
    return agent.id;
  } finally {
    await client.close();
  }
}
