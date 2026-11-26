import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { createRequire } from "node:module";
import type { switchSession } from "../shared/convert";
import { compact } from "./compact";
import { importAgent } from "./daemon";
import { importIntoOpenCode, readOpenCodeSession } from "./opencode";
import { exportAgentTranscript } from "./transcript";

const execFileAsync = promisify(execFile);
// Bounded so a stuck command fails with a message instead of hanging the picker.
const run = (file: string, args: string[]) => execFileAsync(file, args, { timeout: 120_000 });
const log = (message: string) => console.log(`[switch-provider] ${message}`);

// txcript's Node build reads __dirname, which the plugin bundle does not define, and the daemon starts the
// plugin process in its own directory, so find this plugin's folder and require txcript from there.
type Txcript = { toCommon(text: string, from: string): string; fromCommon(json: string, to: string): string };
let loaded: Txcript | undefined;
async function txcript(): Promise<Txcript> {
  if (loaded) return loaded;
  const { stdout } = await run("paseo", ["plugin", "ls", "--json"]);
  const plugins = JSON.parse(stdout) as { id: string; path?: string }[];
  const dir = plugins.find((plugin) => plugin.id === "switch-provider")?.path;
  if (!dir) throw new Error("Could not find the switch-provider plugin folder");
  loaded = createRequire(join(dir, "package.json"))("txcript") as Txcript;
  return loaded;
}

// Paseo provider id -> txcript harness id. Only providers that keep sessions in plain JSONL files.
const HARNESS: Record<string, string> = { claude: "claude_code", codex: "codex", pi: "pi" };

export const supportsConversion = (provider: string) => provider in HARNESS;

const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const codexRoot = () => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
const piRoot = () =>
  process.env.PI_CODING_AGENT_SESSION_DIR ||
  join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions");

async function findFile(root: string, matches: (name: string) => boolean): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "subagents" || entry.name === "tool-results") continue;
      const found = await findFile(path, matches);
      if (found) return found;
    } else if (matches(entry.name)) return path;
  }
  return null;
}

function locateSource(provider: string, sessionId: string) {
  if (provider === "claude") return findFile(claudeRoot(), (n) => n === `${sessionId}.jsonl`);
  if (provider === "codex") return findFile(codexRoot(), (n) => n.startsWith("rollout-") && n.endsWith(`${sessionId}.jsonl`));
  return findFile(piRoot(), (n) => n.endsWith(`_${sessionId}.jsonl`));
}

const stamp = (iso: string) => iso.replace(/[:.]/g, "-");

function targetPath(provider: string, cwd: string, id: string, iso: string) {
  if (provider === "claude") return join(claudeRoot(), cwd.replace(/[/\\.:]/g, "-"), `${id}.jsonl`);
  if (provider === "codex") {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return join(codexRoot(), y, m, d, `rollout-${stamp(iso.slice(0, 19))}-${id}.jsonl`);
  }
  return join(piRoot(), `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`, `${stamp(iso)}_${id}.jsonl`);
}

// OpenCode keeps sessions in a database, so it is read with `opencode session export` and written with `opencode session import`.
const convertible = (from: string, to: string) => (from in HARNESS || from === "opencode") && (to in HARNESS || to === "opencode");

// ponytail: Codex and Copilot report no context size, so assume 200K for them. A table of known sizes would be tighter.
const DEFAULT_WINDOW = 200_000;

async function targetWindow(paseo: PluginHandlerContext["paseo"], provider: string, modelId: string) {
  const { entries } = await paseo.providers.snapshot();
  const model = entries.find((entry) => entry.provider === provider)?.models?.find((m) => m.id === modelId || m.aliases?.includes(modelId));
  return model?.contextWindowMaxTokens ?? DEFAULT_WINDOW;
}

async function convertAndImport(
  snapshot: { provider: string; cwd: string; workspaceId?: string | null; persistence: { sessionId: string } },
  provider: string,
  modelId: string,
  window: number,
) {
  const { cwd } = snapshot;
  log(`reading ${snapshot.provider} session`);
  let common;
  if (snapshot.provider === "opencode") {
    common = await readOpenCodeSession(snapshot.persistence.sessionId, cwd);
  } else {
    const source = await locateSource(snapshot.provider, snapshot.persistence.sessionId);
    if (!source) throw new Error(`Could not find the ${snapshot.provider} session file for ${snapshot.persistence.sessionId}`);
    common = JSON.parse((await txcript()).toCommon(await readFile(source, "utf8"), HARNESS[snapshot.provider]));
  }
  // Leave room for the new provider's own instructions and tools, and for the work still to come.
  const compacted = await compact(common, Math.floor(window * 0.6));
  if (compacted) {
    common = compacted.common;
    log(`compacted about ${compacted.beforeTokens} to ${compacted.afterTokens} tokens for a ${window} token window`);
  }
  log(`writing ${provider} session`);
  let sessionId: string;
  if (provider === "opencode") {
    sessionId = await importIntoOpenCode(common, cwd, modelId);
  } else {
    sessionId = randomUUID();
    common.meta.id = sessionId;
    common.meta.model = modelId;
    common.meta.cwd = cwd;
    const path = targetPath(provider, cwd, sessionId, new Date().toISOString());
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, (await txcript()).fromCommon(JSON.stringify(common), HARNESS[provider]), { flag: "wx" });
  }

  log("importing into Paseo");
  const agentId = await importAgent({ provider, sessionId, cwd, workspaceId: snapshot.workspaceId ?? undefined, modelId });
  log("done");
  return agentId;
}

/** A new agent that reads a full transcript file. Works for any provider pair, at the cost of history that lives in a file instead of the provider's own session. */
async function transcriptHandoff(
  input: { agentId: string; provider: string; title?: string | null; cwd: string },
  target: { provider: string; modelId: string },
  context: PluginHandlerContext,
) {
  const { path } = await exportAgentTranscript({ agentId: input.agentId }, context);
  const prompt = [
    `You are continuing the session of agent ${input.agentId} ("${input.title ?? "untitled"}"), which ran on ${input.provider}.`,
    `Its full transcript, including tool calls and results, is in ${path}. Read the whole file before you act, then continue where that agent stopped.`,
  ].join("\n");
  const created = await context.paseo.agents.create({
    cwd: input.cwd,
    config: { provider: `${target.provider}/${target.modelId}` },
    prompt,
  });
  return created.id;
}

/**
 * Continues the agent on another provider. Claude, Codex and pi sessions are converted to a native session, so history is complete. Other providers get a new agent that reads a full transcript file.
 */
export async function switchAgentSession(
  { agentId, provider, modelId }: RpcInput<typeof switchSession>,
  context: PluginHandlerContext,
) {
  const { paseo } = context;
  const snapshot = (await paseo.agents.ref(agentId).refresh())?.agent;
  if (!snapshot?.cwd) throw new Error("The source agent has no working directory");
  const { persistence, cwd } = snapshot;
  if (convertible(snapshot.provider, provider)) {
    if (!persistence) throw new Error("The source agent has no saved session yet; send it a message first");
    try {
      const window = await targetWindow(paseo, provider, modelId);
      const id = await convertAndImport({ provider: snapshot.provider, cwd, workspaceId: snapshot.workspaceId, persistence }, provider, modelId, window);
      return { agentId: id, method: "converted" as const };
    } catch (cause) {
      // Paseo refuses a native import into OpenCode while it shares a discovered `opencode serve`
      // service ("Custom OpenCode MCP servers or process environment require an isolated server"),
      // and provider session formats drift between releases. A transcript handoff needs to create an
      // agent on the target provider, so it cannot rescue the OpenCode case: report it instead.
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("require an isolated server and cannot be used with a shared OpenCode service")) {
        throw new Error(
          `Paseo is sharing the \`opencode serve\` service already running on this host, so it cannot create or import an OpenCode agent. ` +
            `Stop that service (then Paseo starts its own OpenCode server) or pick a provider Paseo runs itself. Underlying error: ${message}`,
        );
      }
      log(`native conversion ${snapshot.provider} -> ${provider} failed, using a transcript handoff: ${message}`);
    }
  }
  const id = await transcriptHandoff(
    { agentId, provider: snapshot.provider, title: snapshot.title, cwd },
    { provider, modelId },
    context,
  );
  return { agentId: id, method: "transcript" as const };
}
