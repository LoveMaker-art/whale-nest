// @bun
// src/plugin/official/deepseek-harness-entry.ts
import { createHash } from "crypto";
import { fileURLToPath } from "url";

// src/runtime/deepseek-harness-adapter.ts
import { randomUUID } from "crypto";
import { realpathSync as realpathSync2, statSync } from "fs";
import { basename, resolve as resolve2 } from "path";

// src/runtime/deepseek-harness-identity.ts
import { realpathSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
function canonicalDshHome(configured, env) {
  const native = configured?.trim() || env?.DSH_HOME?.trim() || process.env.DSH_HOME?.trim();
  const selected = native ? expandHome(native) : join(homedir(), ".dsh");
  return canonicalPathBestEffort(resolve(selected));
}
function expandHome(path) {
  if (path === "~")
    return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\"))
    return join(homedir(), path.slice(2));
  return path;
}
function canonicalPathBestEffort(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// src/runtime/deepseek-harness-process.ts
import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { createInterface } from "readline";

// src/runtime/deepseek-harness-protocol.ts
var DSH_BRIDGE_PROTOCOL_NAME = "clawchat-connect-dsh-bridge";
var DSH_BRIDGE_PROTOCOL_MAJOR = 1;
var DSH_BRIDGE_MAX_FRAME_BYTES = 1048576;

class DshBridgeRemoteError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "DshBridgeRemoteError";
  }
}
function parseDshBridgeFrame(line) {
  const decoded = JSON.parse(line);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("DSH Bridge frame must be an object");
  }
  const value = decoded;
  if (typeof value.type !== "string")
    throw new Error("DSH Bridge frame must have a type");
  if (value.type === "hello")
    return parseHello(value);
  if (value.type === "response") {
    if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
      throw new Error("DSH Bridge response is malformed");
    }
    if (value.ok)
      return { type: "response", id: value.id, ok: true, result: value.result };
    const error = value.error;
    if (!error || typeof error !== "object" || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("DSH Bridge error response is malformed");
    }
    return {
      type: "response",
      id: value.id,
      ok: false,
      error: { code: error.code, message: error.message }
    };
  }
  if (value.type === "event") {
    if (typeof value.sessionId !== "string" || !isSessionEvent(value.event)) {
      throw new Error("DSH Bridge event frame is malformed");
    }
    return { type: "event", sessionId: value.sessionId, event: value.event };
  }
  if (value.type === "interaction") {
    const request = value.request;
    if (typeof value.id !== "string" || typeof value.sessionId !== "string" || !request || typeof request !== "object" || request.kind !== "approval" && request.kind !== "user-input") {
      throw new Error("DSH Bridge interaction frame is malformed");
    }
    return {
      type: "interaction",
      id: value.id,
      sessionId: value.sessionId,
      request: value.request
    };
  }
  throw new Error(`Unsupported DSH Bridge frame type: ${value.type}`);
}
function parseHello(value) {
  const protocol = value.protocol;
  if (!protocol || typeof protocol !== "object" || protocol.name !== DSH_BRIDGE_PROTOCOL_NAME || typeof protocol.major !== "number" || typeof protocol.build !== "string" || typeof value.home !== "string" || value.profile !== null && typeof value.profile !== "string" || !isCapabilities(value.capabilities)) {
    throw new Error("DSH Bridge hello frame is malformed");
  }
  return value;
}
function isSessionEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const event = value;
  return Number.isSafeInteger(event.seq) && Number.isFinite(event.time) && typeof event.type === "string" && Object.hasOwn(event, "data");
}
function isCapabilities(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const capabilities = value;
  const booleanKeys = [
    "promptQueue",
    "promptSteer",
    "cancel",
    "durableReceipt",
    "history",
    "approvals",
    "questions",
    "models",
    "presets",
    "permissionPresets",
    "skills",
    "commands",
    "imageInput",
    "localProducedFilePresentation",
    "portableArtifactOutput",
    "archive",
    "restore",
    "delete",
    "crossProcessSessionOwnership"
  ];
  return booleanKeys.every((key) => typeof capabilities[key] === "boolean");
}

// src/runtime/deepseek-harness-process.ts
var MAX_STDERR_BYTES = 65536;
var DEFAULT_START_TIMEOUT_MS = 30000;
var DEFAULT_REQUEST_TIMEOUT_MS = 30000;
var DEFAULT_STOP_TIMEOUT_MS = 5000;
function requireDshExecutable(configuredPath, env) {
  const configuredExecutable = configuredPath?.trim();
  if (configuredPath !== undefined && !configuredExecutable) {
    throw new Error("Configured DeepSeek Harness executable path must not be empty");
  }
  const path = env?.PATH ?? process.env.PATH;
  const executable = configuredExecutable ?? Bun.which("dsh", { PATH: path });
  if (executable)
    return { path: executable };
  return requireDshPackageCommand(env);
}
function requireDshPackageCommand(env) {
  const path = env?.PATH ?? process.env.PATH;
  const bunx = Bun.which("bunx", { PATH: path });
  if (bunx) {
    return {
      path: bunx,
      executableArguments: ["@deepseek-ai/dsh"]
    };
  }
  const npx = Bun.which("npx", { PATH: path });
  if (npx) {
    return {
      path: npx,
      executableArguments: ["--yes", "@deepseek-ai/dsh"]
    };
  }
  const pnpm = Bun.which("pnpm", { PATH: path });
  if (pnpm) {
    return {
      path: pnpm,
      executableArguments: ["dlx", "@deepseek-ai/dsh"]
    };
  }
  throw new Error("DeepSeek Harness package launcher was not found; install Bun, Node.js with npx, or pnpm");
}
async function startDshBridge(options) {
  const temporaryDirectory = await mkdtemp(join2(tmpdir(), "clawchat-connect-dsh-"));
  const overlayPath = join2(temporaryDirectory, "bridge.patch.yml");
  await writeFile(overlayPath, [
    "- insert:",
    "    - id: clawchat-connect-bridge",
    `      name: ${JSON.stringify(options.bridgePath)}`,
    "      config:",
    `        build: ${JSON.stringify(options.bridgeBuild)}`,
    `        home: ${JSON.stringify(options.home)}`,
    `        profile: ${JSON.stringify(options.profile ?? null)}`,
    ""
  ].join(`
`));
  let child;
  try {
    child = spawn(options.executable, [
      ...options.executableArguments ?? [],
      ...options.profile ? ["--profile", options.profile] : [],
      "--patch",
      overlayPath
    ], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        DSH_HOME: options.home,
        CONNECT_DSH_BRIDGE_FD_OUT: "3",
        CONNECT_DSH_BRIDGE_FD_IN: "4"
      },
      stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true
    });
    return await SpawnedDshBridge.create(child, temporaryDirectory, options);
  } catch (error) {
    if (child)
      await terminateDshProcess(child, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

class SpawnedDshBridge {
  child;
  temporaryDirectory;
  requestTimeoutMs;
  stopTimeoutMs;
  stderr;
  hello;
  listeners = new Set;
  interactionListeners = new Set;
  pending = new Map;
  output;
  exited;
  requestSequence = 0;
  closing = false;
  failure = null;
  constructor(child, temporaryDirectory, hello, requestTimeoutMs, stopTimeoutMs, stderr) {
    this.child = child;
    this.temporaryDirectory = temporaryDirectory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.stderr = stderr;
    this.hello = hello;
    this.output = child.stdio[4];
    this.exited = new Promise((resolve2) => {
      child.once("close", (code, signal) => {
        if (!this.closing) {
          const detail = this.stderr.text.trim();
          this.fail(new Error(`DeepSeek Harness process exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`));
        }
        resolve2();
      });
    });
  }
  static async create(child, temporaryDirectory, options) {
    const input = child.stdio[3];
    const stderrStream = child.stderr;
    if (!input || !stderrStream || !child.stdio[4])
      throw new Error("DeepSeek Harness inherited pipes were not created");
    const stderr = { text: "" };
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk) => {
      stderr.text = `${stderr.text}${chunk}`.slice(-MAX_STDERR_BYTES);
    });
    let settleHello;
    let rejectHello;
    const helloPromise = new Promise((resolve2, reject) => {
      settleHello = resolve2;
      rejectHello = reject;
    });
    let bridge;
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (Buffer.byteLength(line) > DSH_BRIDGE_MAX_FRAME_BYTES) {
        const error = new Error("DeepSeek Harness Bridge emitted an oversized frame");
        bridge?.fail(error);
        rejectHello(error);
        child.kill("SIGTERM");
        return;
      }
      let frame;
      try {
        frame = parseDshBridgeFrame(line);
      } catch (cause) {
        const error = new Error("DeepSeek Harness Bridge emitted a malformed frame", { cause });
        bridge?.fail(error);
        rejectHello(error);
        child.kill("SIGTERM");
        return;
      }
      if (!bridge) {
        if (frame.type !== "hello") {
          rejectHello(new Error("DeepSeek Harness Bridge did not emit hello first"));
          child.kill("SIGTERM");
          return;
        }
        settleHello(frame);
        return;
      }
      bridge.receive(frame);
    });
    child.once("error", (cause) => {
      const error = new Error("DeepSeek Harness process could not be started", { cause });
      bridge?.fail(error);
      rejectHello(error);
    });
    child.once("close", (code, signal) => {
      if (bridge)
        return;
      const detail = stderr.text.trim();
      rejectHello(new Error(`DeepSeek Harness Profile boot failed (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`));
    });
    let hello;
    try {
      hello = await withTimeout(helloPromise, options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS, "DeepSeek Harness Bridge handshake timed out");
    } catch (cause) {
      const detail = stderr.text.trim();
      const missingProfileService = cause instanceof Error && cause.message === "DeepSeek Harness Bridge handshake timed out";
      throw new Error(missingProfileService ? "workspace-registry-missing: selected DeepSeek Harness Profile did not activate the Bridge's required services" : `DeepSeek Harness Bridge handshake failed${detail ? `: ${detail}` : ""}`, { cause });
    }
    if (hello.protocol.major !== DSH_BRIDGE_PROTOCOL_MAJOR) {
      throw new Error(`DeepSeek Harness Bridge protocol major ${hello.protocol.major} is incompatible with ${DSH_BRIDGE_PROTOCOL_MAJOR}`);
    }
    bridge = new SpawnedDshBridge(child, temporaryDirectory, hello, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, stderr);
    return bridge;
  }
  async request(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.failure)
      throw this.failure;
    if (this.closing && method !== "shutdown")
      throw new Error("DeepSeek Harness Bridge is closing");
    const id = `connect-${++this.requestSequence}`;
    const frame = { type: "request", id, method, params };
    const encoded = `${JSON.stringify(frame)}
`;
    if (Buffer.byteLength(encoded) > DSH_BRIDGE_MAX_FRAME_BYTES) {
      throw new Error(`DeepSeek Harness Bridge request ${method} exceeds the frame limit`);
    }
    const reply = new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DeepSeek Harness Bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timeout });
    });
    try {
      if (!this.output.write(encoded))
        await new Promise((resolve2) => this.output.once("drain", resolve2));
    } catch (cause) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
      }
      throw new Error(`DeepSeek Harness Bridge request could not be written: ${method}`, { cause });
    }
    return await reply;
  }
  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onInteraction(listener) {
    this.interactionListeners.add(listener);
    return () => this.interactionListeners.delete(listener);
  }
  async close() {
    if (this.closing)
      return await this.exited;
    this.closing = true;
    try {
      if (this.child.exitCode === null && !this.failure) {
        await this.request("shutdown", {}, this.stopTimeoutMs).catch(() => {
          return;
        });
        this.output.end();
        this.child.stdin?.end();
      }
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          await withTimeout(this.exited, this.stopTimeoutMs, "DSH shutdown timed out");
        } catch {
          await terminateDshProcess(this.child, this.stopTimeoutMs);
        }
      }
      await withTimeout(this.exited, this.stopTimeoutMs, "DSH process did not close");
    } finally {
      this.fail(new Error("DeepSeek Harness Bridge closed"));
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    }
  }
  receive(frame) {
    if (frame.type === "hello") {
      this.fail(new Error("DeepSeek Harness Bridge emitted more than one hello frame"));
      this.child.kill("SIGTERM");
      return;
    }
    if (frame.type === "event") {
      for (const listener of this.listeners)
        listener(frame);
      return;
    }
    if (frame.type === "interaction") {
      for (const listener of this.interactionListeners)
        listener(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending)
      return;
    clearTimeout(pending.timeout);
    this.pending.delete(frame.id);
    if (frame.ok)
      pending.resolve(frame.result);
    else
      pending.reject(new DshBridgeRemoteError(frame.error.code, frame.error.message));
  }
  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
}
async function terminateDshProcess(child, timeoutMs) {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve2) => child.once("exit", () => resolve2()));
    child.kill("SIGTERM");
    try {
      await withTimeout(exited, timeoutMs, "DSH termination timed out");
    } catch {
      child.kill("SIGKILL");
      await withTimeout(exited, timeoutMs, "DSH process could not be reaped");
    }
  }
  for (const stream of child.stdio)
    stream?.destroy();
}
async function withTimeout(operation, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout)
      clearTimeout(timeout);
  }
}

// src/runtime/types.ts
function runtimeInputIdentity(text) {
  const match = /^<clawchat_turn_context>\n([^\n]+)\n<\/clawchat_turn_context>/u.exec(text);
  if (!match?.[1])
    return null;
  try {
    const value = recordValue(JSON.parse(match[1]));
    if (value?.origin !== "clawchat")
      return null;
    const anchor = inputMessageIdentity(value);
    if (!anchor)
      return null;
    const groupBatch = value.group_batch === undefined ? null : recordValue(value.group_batch);
    if (value.group_batch !== undefined && !groupBatch)
      return null;
    const rawActionable = groupBatch?.messages;
    if (groupBatch && !Array.isArray(rawActionable))
      return null;
    const actionable = groupBatch ? inputMessageIdentities(rawActionable) : [anchor];
    if (!actionable || actionable.length === 0)
      return null;
    const rawContext = value.recent_group_context;
    if (rawContext !== undefined && !Array.isArray(rawContext))
      return null;
    const context = rawContext === undefined ? [] : inputMessageIdentities(rawContext);
    if (!context)
      return null;
    if (!hasUniqueMessageIds(actionable) || !hasUniqueMessageIds(context))
      return null;
    const actionableMessageIds = new Set(actionable.map((item) => item.messageId));
    if (context.some((item) => actionableMessageIds.has(item.messageId)))
      return null;
    if (groupBatch) {
      const matchingAnchors = actionable.filter((item) => item.messageId === anchor.messageId);
      if (matchingAnchors.length !== 1 || matchingAnchors[0]?.contentDigest !== anchor.contentDigest)
        return null;
    }
    return { origin: "clawchat", anchor, actionable, context };
  } catch {
    return null;
  }
}
function runtimeInputIdentityContains(identity, candidate) {
  return [...identity.actionable, ...identity.context].some((item) => item.messageId === candidate.messageId && item.contentDigest === candidate.contentDigest);
}
function inputMessageIdentities(values) {
  const identities = values.map((value) => inputMessageIdentity(recordValue(value)));
  return identities.every((identity) => identity !== null) ? identities : null;
}
function inputMessageIdentity(value) {
  if (!value)
    return null;
  const messageId = value.message_id;
  const contentDigest = value.content_digest;
  return typeof messageId === "string" && messageId.length > 0 && typeof contentDigest === "string" && contentDigest.length > 0 ? { messageId, contentDigest } : null;
}
function hasUniqueMessageIds(identities) {
  return new Set(identities.map((identity) => identity.messageId)).size === identities.length;
}
function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
class RuntimeLifecycleError extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "RuntimeLifecycleError";
  }
}

// src/runtime/deepseek-harness-adapter.ts
function createDeepSeekHarnessRuntimeAdapter(options) {
  let prepared = null;
  let preparing = null;
  let closed = false;
  const lifecycleCapabilities = { archive: false, restore: false, delete: false };
  const ensurePrepared = async (binding) => {
    if (closed)
      throw new Error("DeepSeek Harness Runtime Adapter is closed");
    const harnessBinding = requireHarnessBinding(binding);
    if (prepared) {
      assertSameBinding(prepared.binding, harnessBinding);
      return prepared;
    }
    if (preparing)
      return await preparing;
    preparing = prepareHarness(harnessBinding, options);
    try {
      prepared = await preparing;
      lifecycleCapabilities.archive = prepared.client.hello.capabilities.archive;
      return prepared;
    } finally {
      preparing = null;
    }
  };
  return {
    kind: "deepseek-harness",
    modes: [],
    lifecycleCapabilities,
    async prepare(binding) {
      await ensurePrepared(binding);
    },
    async listModels(binding) {
      const harness = await ensurePrepared(binding);
      const models = await harness.client.request("models", {});
      return models.map(runtimeModelOption);
    },
    async listSessionOptions(binding) {
      const harness = await ensurePrepared(binding);
      const options2 = [];
      if (harness.client.hello.capabilities.presets) {
        const catalog = await harness.client.request("presets", {});
        options2.push({
          id: "agentPreset",
          displayName: "Agent Preset",
          description: "DeepSeek Harness Agent composition",
          category: "agent",
          changePolicy: "new-runtime-session",
          defaultValue: catalog.defaultId,
          values: catalog.presets.map((preset) => ({
            id: preset.id,
            displayName: preset.name ?? preset.id,
            ...preset.description ? { description: preset.description } : {},
            ...preset.broken ? { unavailable: true, description: preset.broken } : {}
          }))
        });
      }
      if (harness.client.hello.capabilities.permissionPresets) {
        const catalog = await harness.client.request("permissionPresets", {});
        options2.push({
          id: "permissionPreset",
          displayName: "Permission Preset",
          description: "DeepSeek Harness sandbox and approval policy",
          category: "execution",
          changePolicy: "new-runtime-session",
          defaultValue: catalog.defaultId,
          values: catalog.presets.map((preset) => ({
            id: preset.id,
            displayName: preset.name,
            ...preset.description ? { description: preset.description } : {}
          }))
        });
      }
      return options2;
    },
    async listSkills(binding, workspace, catalogOptions) {
      const harness = await ensurePrepared(binding);
      if (!harness.client.hello.capabilities.skills)
        return [];
      const skills = await harness.client.request("skills", {
        cwd: canonicalWorkspace(workspace),
        ...catalogOptions?.runtimeThreadId ? { sessionId: catalogOptions.runtimeThreadId } : {}
      });
      return skills.filter((skill) => skill.userInvocable).map((skill) => ({ id: `dsh-skill:${skill.name}`, name: skill.name, description: skill.description }));
    },
    async listCommands(binding, _workspace, catalogOptions) {
      const harness = await ensurePrepared(binding);
      if (!harness.client.hello.capabilities.commands || !catalogOptions?.runtimeThreadId)
        return [];
      const commands = await harness.client.request("commands", {
        sessionId: catalogOptions.runtimeThreadId
      });
      return commands.map((command) => ({
        id: `dsh-command:${command.name}`,
        name: command.name,
        description: command.description
      }));
    },
    async discoverThreads(binding, workspace) {
      const harness = await ensurePrepared(binding);
      const cwd = canonicalWorkspace(workspace);
      return discoverySnapshot(await discover(harness.client), (session) => !session.archived && session.header.cwd === cwd);
    },
    async discoverAllThreads(binding) {
      const harness = await ensurePrepared(binding);
      return discoverySnapshot(await discover(harness.client), (session) => !session.archived);
    },
    async discoverArchivedThreads(binding) {
      const harness = await ensurePrepared(binding);
      return discoverySnapshot(await discover(harness.client), (session) => session.archived);
    },
    async verifyThreadReady(binding, runtimeThreadId) {
      const harness = await ensurePrepared(binding);
      await harness.client.request("history", { sessionId: runtimeThreadId });
    },
    async readActivity(binding, runtimeThreadId) {
      const harness = await ensurePrepared(binding);
      const history = await harness.client.request("history", { sessionId: runtimeThreadId });
      return projectDshHistory(runtimeThreadId, history.events);
    },
    async reconcileInput(binding, runtimeThreadId, candidate) {
      const harness = await ensurePrepared(binding);
      return await reconcileDshInput(harness.client, runtimeThreadId, candidate);
    },
    async archiveThread(binding, runtimeThreadId) {
      const harness = await ensurePrepared(binding);
      try {
        await harness.client.request("archive", { sessionId: runtimeThreadId });
      } catch (error) {
        if (error instanceof DshBridgeRemoteError && (error.code === "conflict" || error.code === "session-not-owned")) {
          throw new RuntimeLifecycleError("conflict", error.message, { cause: error });
        }
        if (error instanceof DshBridgeRemoteError && error.code === "session-not-found") {
          throw new RuntimeLifecycleError("not-found", error.message, { cause: error });
        }
        throw error;
      }
    },
    async start(binding, context) {
      const harness = await ensurePrepared(binding);
      return new DeepSeekHarnessRuntimeSession(harness.client, context);
    },
    async close() {
      if (closed)
        return;
      closed = true;
      const active = prepared ?? (preparing ? await preparing.catch(() => null) : null);
      prepared = null;
      preparing = null;
      await active?.client.close();
    }
  };
}
async function prepareHarness(binding, options) {
  const home = canonicalDshHome(binding.homePath, binding.env);
  const cwd = process.cwd();
  const executable = (options.probeExecutable ?? requireDshExecutable)(binding.executablePathOverride, binding.env);
  const client = await (options.createBridge ?? startDshBridge)({
    executable: executable.path,
    ...executable.executableArguments ? { executableArguments: executable.executableArguments } : {},
    home,
    ...binding.profile ? { profile: binding.profile } : {},
    cwd,
    bridgePath: options.bridgePath,
    bridgeBuild: options.bridgeBuild,
    env: binding.env
  });
  try {
    assertCompatibleHello(client, home, binding.profile);
    return { binding, home, client };
  } catch (error) {
    await client.close();
    throw error;
  }
}
function assertCompatibleHello(client, home, profile) {
  const hello = client.hello;
  if (hello.home !== home || hello.profile !== (profile ?? null)) {
    throw new Error("DeepSeek Harness Bridge booted a different Home or Profile than Connect requested");
  }
}

class DeepSeekHarnessRuntimeSession {
  client;
  context;
  runtimeThreadId;
  active = null;
  closed = false;
  constructor(client, context) {
    this.client = client;
    this.context = context;
    this.runtimeThreadId = context.runtimeSessionId;
  }
  async* prompt(input) {
    if (this.closed)
      throw new Error("DeepSeek Harness Runtime Session is closed");
    if (this.active)
      throw new Error("DeepSeek Harness Runtime Session already has an active turn");
    const images = await stageDshImages(input, this.context);
    if (input.command && images.length > 0) {
      throw new Error("DeepSeek Harness Runtime Commands do not accept attachment input");
    }
    const runtimeThreadId = await this.ensureThread(input);
    if (input.model) {
      await this.client.request("selectModel", {
        sessionId: runtimeThreadId,
        model: dshModelSelection(input.model, input.reasoningEffort)
      });
    }
    const history = await this.client.request("history", { sessionId: runtimeThreadId });
    const projector = new DshActivityProjector(runtimeThreadId);
    for (const event of history.events)
      projector.accept(event, "history");
    const queue = new DshActivityQueue;
    this.active = {
      queue,
      cancelRequested: false,
      interactionControllers: new Set
    };
    const off = this.client.onEvent((frame) => {
      if (frame.sessionId !== runtimeThreadId)
        return;
      for (const activity of projector.accept(frame.event, "live"))
        queue.push(activity);
      if (frame.event.type === "turn/end")
        queue.close();
    });
    const offInteraction = this.client.onInteraction((interaction) => {
      if (interaction.sessionId !== runtimeThreadId)
        return;
      this.handleInteraction(interaction, input).catch((error) => queue.fail(error instanceof Error ? error : new Error(String(error))));
    });
    try {
      if (input.command) {
        await this.executeCommand(input, runtimeThreadId, queue);
      } else {
        const inputId = input.turnId ?? `connect-${randomUUID()}`;
        await this.client.request("prompt", {
          sessionId: runtimeThreadId,
          inputId,
          text: input.prompt,
          mode: input.mode === "steer" ? "steer" : "followup",
          ...input.skill ? { skillName: requireSelectionName(input.skill.id, input.skill.name, "dsh-skill:") } : {},
          ...images.length > 0 ? { images } : {}
        });
        await input.onAccepted?.();
      }
      yield* queue;
    } catch (error) {
      queue.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      off();
      offInteraction();
      if (this.active?.queue === queue)
        this.active = null;
    }
  }
  async cancel() {
    const active = this.active;
    if (!active || !this.runtimeThreadId || active.cancelRequested)
      return false;
    active.cancelRequested = true;
    for (const controller of active.interactionControllers)
      controller.abort();
    const result = await this.client.request("cancel", {
      sessionId: this.runtimeThreadId
    });
    if (result.reason !== "aborted" || !result.idle) {
      throw new Error("DeepSeek Harness did not confirm an aborted terminal turn and idle Agent");
    }
    return true;
  }
  async close() {
    if (this.closed)
      return;
    await this.cancel().catch(() => {
      return;
    });
    this.closed = true;
  }
  async handleInteraction(interaction, input) {
    const active = this.active;
    if (!active)
      return;
    const controller = new AbortController;
    active.interactionControllers.add(controller);
    const delivery = interactionDelivery();
    try {
      let response;
      if (!input.interactionPort || !input.metadata?.sessionRef || !input.turnId || !input.turnOrigin) {
        response = interaction.request.kind === "approval" ? { kind: "approval", optionId: "deny" } : { kind: "approval", optionId: "cancel" };
      } else {
        try {
          response = await input.interactionPort.request(interaction.request, {
            sessionRef: input.metadata.sessionRef,
            turnId: input.turnId,
            origin: input.turnOrigin,
            deliveryConfirmation: delivery.promise,
            signal: controller.signal
          });
        } catch {
          response = interaction.request.kind === "approval" ? { kind: "approval", optionId: controller.signal.aborted ? "cancel" : "deny" } : { kind: "approval", optionId: "cancel" };
        }
      }
      await this.client.request("interactionResponse", {
        id: interaction.id,
        sessionId: interaction.sessionId,
        response
      });
      delivery.confirm();
    } catch (error) {
      delivery.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      active.interactionControllers.delete(controller);
    }
  }
  async ensureThread(input) {
    const cwd = canonicalWorkspace(input.workspace);
    if (this.runtimeThreadId) {
      const resumed = await this.client.request("resume", {
        whalenestChatId: this.context.chatId,
        sessionId: this.runtimeThreadId
      });
      if (resumed.header.cwd !== cwd) {
        throw new Error("DeepSeek Harness resumed the Session with a different Workspace");
      }
      return resumed.sessionId;
    }
    const sessionId = `clawchat-${randomUUID()}`;
    const model = input.model ? dshModelSelection(input.model, input.reasoningEffort) : undefined;
    const created = await this.client.request("create", {
      whalenestChatId: this.context.chatId,
      sessionId,
      cwd,
      ...model ? { model } : {},
      ...input.sessionOptions?.agentPreset ? { agentPreset: input.sessionOptions.agentPreset } : {},
      ...input.sessionOptions?.permissionPreset ? { permissionPreset: input.sessionOptions.permissionPreset } : {}
    });
    if (created.header.cwd !== cwd)
      throw new Error("DeepSeek Harness created the Session with a different Workspace");
    this.runtimeThreadId = created.sessionId;
    await this.context.onRuntimeSessionId(created.sessionId);
    return created.sessionId;
  }
  async executeCommand(input, runtimeThreadId, queue) {
    const command = input.command;
    if (!command)
      throw new Error("DeepSeek Harness Command selection is missing");
    const name = requireSelectionName(command.id, command.name, "dsh-command:");
    const result = await this.client.request("command", {
      sessionId: runtimeThreadId,
      line: `/${name}${input.prompt ? ` ${input.prompt}` : ""}`
    });
    await input.onAccepted?.();
    queue.push({
      id: `dsh:${runtimeThreadId}:command:${input.turnId ?? randomUUID()}`,
      position: "0.0",
      parentId: null,
      kind: "progress",
      text: commandResultText(result),
      state: "complete",
      source: "live"
    });
    queue.close();
  }
}

class DshActivityProjector {
  sessionId;
  activities = new Map;
  positions = new Map;
  nextItemByTurn = new Map;
  latestAssistantByTurn = new Map;
  currentTurn = 0;
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
  accept(event, source) {
    const data = eventData(event);
    if (Number.isSafeInteger(data.turn))
      this.currentTurn = data.turn;
    switch (event.type) {
      case "turn/start":
      case "step/start":
      case "step/end":
      case "request/header":
      case "request/context":
      case "session/end-seed":
      case "session/title":
      case "session/title-llm-request":
      case "agent/inbox/spliced":
        return [];
      case "user/message":
        if (objectValue(data.source).kind !== "user")
          return [];
        return [this.replace(messageActivity(this.sessionId, event, data, this.currentTurn, source))];
      case "assistant/chunk":
        return this.assistantChunk(event, data, source);
      case "assistant/message":
        return this.assistantMessage(event, data, source);
      case "tool/call":
        return [this.replace(toolCallActivity(this.sessionId, event, data, source))];
      case "tool/result":
        return [this.toolResult(event, data, source)];
      case "turn/end":
        return this.completeTurn(event, data, source);
      case "command/run":
      case "command/done":
        return [this.replace(commandEventActivity(this.sessionId, event, data, source))];
      default:
        return [this.replace(unknownActivity(this.sessionId, event, data, source, this.currentTurn))];
    }
  }
  snapshot() {
    return [...this.activities.values()].sort((left, right) => comparePositions(left.position, right.position));
  }
  assistantChunk(event, data, source) {
    const chunk = objectValue(data.chunk);
    const turn = integerValue(data.turn, this.currentTurn);
    const step = integerValue(data.step, 0);
    const type = stringValue(chunk.type);
    if (type !== "text-delta" && type !== "reasoning-delta") {
      if (type === "block-start" || type === "block-end" || type === "usage" || type === "finish")
        return [];
      return [this.replace(unknownActivity(this.sessionId, event, data, source, this.currentTurn))];
    }
    const kind = type === "reasoning-delta" ? "reasoning" : "assistant";
    const id = `dsh:${this.sessionId}:${kind}:${turn}:${step}`;
    const previous = this.activities.get(id);
    const activity = {
      id,
      position: previous?.position ?? this.position(id, turn),
      parentId: null,
      kind,
      text: `${previous?.text ?? ""}${stringValue(chunk.text)}`,
      state: "streaming",
      source,
      data: { nativeSeq: event.seq, nativeType: event.type, outputKind: kind }
    };
    this.activities.set(id, activity);
    return [activity];
  }
  assistantMessage(event, data, source) {
    const turn = integerValue(data.turn, this.currentTurn);
    const step = integerValue(data.step, 0);
    const message = objectValue(data.message);
    const content = message.content;
    const activities = [];
    const reasoningId = `dsh:${this.sessionId}:reasoning:${turn}:${step}`;
    const previousReasoning = this.activities.get(reasoningId);
    const reasoning = contentTypeText(content, "reasoning") || previousReasoning?.text || "";
    if (reasoning) {
      activities.push(this.replace({
        id: reasoningId,
        position: previousReasoning?.position ?? this.position(reasoningId, turn),
        parentId: null,
        kind: "reasoning",
        text: reasoning,
        state: "complete",
        source,
        data: { nativeSeq: event.seq, nativeType: event.type, outputKind: "reasoning" }
      }));
    }
    const assistantId = `dsh:${this.sessionId}:assistant:${turn}:${step}`;
    const previousAssistant = this.activities.get(assistantId);
    const text = contentTypeText(content, "text") || previousAssistant?.text || "";
    if (text) {
      activities.push(this.replace({
        id: assistantId,
        position: previousAssistant?.position ?? this.position(assistantId, turn),
        parentId: null,
        kind: "assistant",
        text,
        state: "complete",
        source,
        data: { nativeSeq: event.seq, nativeType: event.type, outputKind: "assistant" }
      }));
      this.latestAssistantByTurn.set(turn, assistantId);
    }
    return activities;
  }
  completeTurn(event, data, source) {
    const turn = integerValue(data.turn, this.currentTurn);
    const activities = [];
    const assistantId = this.latestAssistantByTurn.get(turn);
    const assistant = assistantId ? this.activities.get(assistantId) : undefined;
    if (assistant?.state === "complete") {
      activities.push(this.replace({
        ...assistant,
        data: { ...assistant.data, outputKind: "final" }
      }));
    }
    this.latestAssistantByTurn.delete(turn);
    activities.push(this.replace(turnEndActivity(this.sessionId, event, data, source)));
    return activities;
  }
  toolResult(event, data, source) {
    const message = objectValue(data.message);
    const messageSource = objectValue(message.source);
    const content = Array.isArray(message.content) ? message.content : [];
    const first = objectValue(content[0]);
    const callId = stringValue(messageSource.callId) || stringValue(first.toolCallId) || `seq-${event.seq}`;
    const id = `dsh:${this.sessionId}:tool:${callId}`;
    const previous = this.activities.get(id);
    return this.replace({
      id,
      position: previous?.position ?? this.position(id, integerValue(data.turn, this.currentTurn)),
      parentId: null,
      kind: "tool",
      text: contentText(first.content ?? message.content),
      state: first.isError === true ? "error" : "complete",
      source,
      data: { ...previous?.data ?? {}, nativeSeq: event.seq, nativeType: event.type, callId }
    });
  }
  replace(activity) {
    const turn = activityTurn(activity.position, this.currentTurn);
    const normalized = {
      ...activity,
      position: this.positions.get(activity.id) ?? this.position(activity.id, turn)
    };
    this.activities.set(normalized.id, normalized);
    return normalized;
  }
  position(id, turn) {
    const existing = this.positions.get(id);
    if (existing)
      return existing;
    const next = this.nextItemByTurn.get(turn) ?? 0;
    const position = `${turn}.${next}`;
    this.nextItemByTurn.set(turn, next + 1);
    this.positions.set(id, position);
    return position;
  }
}
function projectDshHistory(sessionId, events) {
  const projector = new DshActivityProjector(sessionId);
  for (const event of events)
    projector.accept(event, "history");
  return { activities: projector.snapshot(), completeness: "complete", limitations: [] };
}
function interactionDelivery() {
  let confirm;
  let fail;
  const promise = new Promise((resolve3, reject) => {
    confirm = resolve3;
    fail = reject;
  });
  promise.catch(() => {
    return;
  });
  return { promise, confirm, fail };
}
async function reconcileDshInput(client, runtimeThreadId, candidate) {
  const history = await client.request("history", { sessionId: runtimeThreadId });
  const identities = history.events.flatMap((event) => {
    if (event.type !== "user/message")
      return [];
    const text = contentText(objectValue(event.data).content);
    const identity2 = runtimeInputIdentity(text);
    return identity2 ? [identity2] : [];
  });
  const identity = identities.find((value) => runtimeInputIdentityContains(value, candidate));
  const receipts = { identities, complete: true };
  return identity ? { outcome: "accepted", identity, receipts } : { outcome: "absent", receipts };
}
function discoverySnapshot(sessions, include) {
  return {
    status: "complete",
    threads: sessions.filter((session) => session.header.origin !== "subagent" && include(session)).map((session) => {
      const summary = runtimeThreadSummary(session);
      if (!session.header.cwd || !usableWorkspace(session.header.cwd)) {
        return {
          ...summary,
          adoption: {
            status: "unavailable",
            reason: "workspace-unusable",
            detail: session.header.cwd ? `Workspace is not a usable directory: ${session.header.cwd}` : "Session has no Workspace"
          }
        };
      }
      if (session.archived) {
        return {
          ...summary,
          adoption: { status: "unavailable", reason: "archived" }
        };
      }
      return { ...summary, adoption: { status: "available" } };
    }),
    limitations: []
  };
}
function runtimeThreadSummary(session) {
  const cwd = session.header.cwd;
  return {
    runtimeThreadId: session.header.id,
    parentRuntimeThreadId: session.header.parentSession ?? null,
    isArchived: session.archived,
    name: session.title,
    updatedAt: session.updatedAt,
    workingDirectory: cwd ?? null,
    ...cwd ? {
      workspaceKind: "persistent",
      workspaceIdentity: { key: canonicalPathBestEffort2(cwd), kind: "persistent", localRoot: cwd }
    } : {}
  };
}
function runtimeModelOption(model) {
  const efforts = model.reasoning?.efforts.map((effort) => effort.id) ?? [];
  return {
    id: `${model.provider}:${model.id}`,
    displayName: model.name,
    description: model.description ?? `${model.provider} / ${model.id}`,
    isDefault: model.isDefault === true,
    defaultReasoningEffort: model.reasoning?.defaultEffort ?? "",
    supportedReasoningEfforts: efforts,
    inputModalities: (model.inputModalities ?? ["text"]).filter((modality) => modality === "text" || modality === "image" || modality === "audio"),
    selection: { provider: model.provider, model: model.id },
    turnSubmissionCapability: {
      prompt: { allowed: true, required: true },
      attachments: {
        allowedKinds: model.imageLimits ? ["image"] : [],
        allowedMediaTypes: model.imageLimits?.mediaTypes ?? [],
        ...model.imageLimits ? {
          maxCount: model.imageLimits.maxImagesPerMessage,
          maxBytesEach: model.imageLimits.maxImageBytes,
          maxBytesTotal: model.imageLimits.maxMessageImageBytes
        } : {}
      }
    }
  };
}
function requireHarnessBinding(binding) {
  const value = binding;
  if (value.profile !== undefined && !value.profile.trim()) {
    throw new Error("DeepSeek Harness Profile must not be empty when configured");
  }
  return value;
}
function assertSameBinding(prepared, candidate) {
  if (prepared.profile !== candidate.profile || prepared.homePath !== candidate.homePath || prepared.executablePathOverride !== candidate.executablePathOverride) {
    throw new Error("DeepSeek Harness Runtime Adapter cannot change Home, Profile, or executable after activation");
  }
}
function canonicalWorkspace(workspace) {
  try {
    const canonical = realpathSync2(resolve2(workspace.workingDirectory));
    if (!statSync(canonical).isDirectory())
      throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new Error(`DeepSeek Harness Workspace does not exist or is unusable: ${workspace.workingDirectory}`, {
      cause: error
    });
  }
}
function usableWorkspace(path) {
  try {
    return statSync(realpathSync2(path)).isDirectory();
  } catch {
    return false;
  }
}
function canonicalPathBestEffort2(path) {
  try {
    return realpathSync2(path);
  } catch {
    return resolve2(path);
  }
}
async function discover(client) {
  return await client.request("discover", {});
}
function dshModelSelection(selection, reasoningEffort) {
  if (!selection.provider)
    throw new Error("DeepSeek Harness model selection requires a provider route");
  return {
    provider: selection.provider,
    model: selection.model,
    ...reasoningEffort ? { reasoningEffort } : {}
  };
}
async function stageDshImages(input, context) {
  const images = [];
  for (const media of input.media ?? []) {
    if (media.kind !== "image") {
      throw new Error(`DeepSeek Harness does not support ${media.kind} attachment input`);
    }
    if (!media.mime || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(media.mime)) {
      throw new Error(`DeepSeek Harness does not support image media type ${media.mime ?? "unknown"}`);
    }
    const stagedPath = context.cacheMedia ? await context.cacheMedia(media, input.trustedMediaOrigins) : media.stagedPath;
    if (!stagedPath)
      throw new Error("DeepSeek Harness image staging is unavailable");
    images.push({
      path: resolve2(stagedPath),
      mediaType: media.mime,
      ...media.name ? { name: basename(media.name) } : {}
    });
  }
  return images;
}
function requireSelectionName(id, name, prefix) {
  if (id !== `${prefix}${name}`)
    throw new Error(`DeepSeek Harness selection is stale: ${name}`);
  return name;
}
function messageActivity(sessionId, event, data, turn, source) {
  const text = contentText(data.content);
  const inputIdentity = runtimeInputIdentity(text);
  return {
    id: `dsh:${sessionId}:message:${stringValue(data.id) || event.seq}`,
    position: `${integerValue(data.turn, turn)}.0`,
    parentId: null,
    kind: "user",
    text,
    state: "complete",
    source,
    ...inputIdentity ? { inputIdentity } : {},
    data: {
      nativeSeq: event.seq,
      nativeType: event.type,
      deliveryDisposition: "projection-only"
    }
  };
}
function toolCallActivity(sessionId, event, data, source) {
  const callId = stringValue(data.callId) || `seq-${event.seq}`;
  return {
    id: `dsh:${sessionId}:tool:${callId}`,
    position: `${integerValue(data.turn, 0)}.0`,
    parentId: null,
    kind: "tool",
    text: `${stringValue(data.name) || "tool"} ${stringValue(data.arguments)}`.trim(),
    state: "streaming",
    source,
    data: { nativeSeq: event.seq, nativeType: event.type, callId, name: stringValue(data.name) }
  };
}
function turnEndActivity(sessionId, event, data, source) {
  const reason = objectValue(data.reason);
  const reasonKind = stringValue(reason.kind) || "unknown";
  const state = reasonKind === "completed" || reasonKind === "max-tokens" ? "complete" : reasonKind === "aborted" ? "cancelled" : "error";
  return {
    id: `dsh:${sessionId}:turn:${integerValue(data.turn, 0)}`,
    position: `${integerValue(data.turn, 0)}.0`,
    parentId: null,
    kind: "turn",
    text: reasonKind === "completed" ? "Turn completed." : `Turn ended: ${reasonKind}`,
    state,
    source,
    data: {
      nativeSeq: event.seq,
      nativeType: event.type,
      reason: reasonKind,
      outputKind: reasonKind === "completed" ? "progress" : "final"
    }
  };
}
function commandEventActivity(sessionId, event, data, source) {
  const commandId = stringValue(data.commandId) || `seq-${event.seq}`;
  return {
    id: `dsh:${sessionId}:command:${commandId}`,
    position: "0.0",
    parentId: null,
    kind: "progress",
    text: stringValue(data.name) || stringValue(data.result) || event.type,
    state: event.type === "command/done" ? "complete" : "streaming",
    source,
    data: { nativeSeq: event.seq, nativeType: event.type, commandId }
  };
}
function unknownActivity(sessionId, event, data, source, turn) {
  return {
    id: `dsh:${sessionId}:event:${event.seq}`,
    position: `${integerValue(data.turn, turn)}.0`,
    parentId: null,
    kind: "unknown",
    text: `${event.type}: ${safeJson(data)}`,
    state: "complete",
    source,
    data: { nativeSeq: event.seq, nativeType: event.type }
  };
}
function eventData(event) {
  return objectValue(event.data);
}
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
  return typeof value === "string" ? value : "";
}
function integerValue(value, fallback) {
  return Number.isSafeInteger(value) ? value : fallback;
}
function contentText(value) {
  if (!Array.isArray(value))
    return "";
  return value.map((entry) => {
    const block = objectValue(entry);
    if (block.type === "text" || block.type === "reasoning")
      return stringValue(block.text);
    if (block.type === "tool-result")
      return contentText(block.content);
    return "";
  }).filter(Boolean).join(`
`);
}
function contentTypeText(value, type) {
  if (!Array.isArray(value))
    return "";
  return value.map((entry) => {
    const block = objectValue(entry);
    return block.type === type ? stringValue(block.text) : "";
  }).filter(Boolean).join(`
`);
}
function commandResultText(value) {
  const record = objectValue(value);
  const result = objectValue(record.result);
  return stringValue(result.text) || stringValue(record.text) || safeJson(value);
}
function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? `${text.slice(0, 1999)}\u2026` : text;
  } catch {
    return "[unserializable]";
  }
}
function activityTurn(position, fallback) {
  const turn = Number(position.split(".", 1)[0]);
  return Number.isSafeInteger(turn) ? turn : fallback;
}
function comparePositions(left, right) {
  const [leftTurn, leftItem] = left.split(".").map(Number);
  const [rightTurn, rightItem] = right.split(".").map(Number);
  return (leftTurn ?? 0) - (rightTurn ?? 0) || (leftItem ?? 0) - (rightItem ?? 0);
}

class DshActivityQueue {
  values = [];
  waiters = [];
  closed = false;
  failure = null;
  push(value) {
    if (this.closed)
      return;
    const waiter = this.waiters.shift();
    if (waiter)
      waiter.resolve({ done: false, value });
    else
      this.values.push(value);
  }
  close() {
    if (this.closed)
      return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.resolve({ done: true, value: undefined });
  }
  fail(error) {
    if (this.closed)
      return;
    this.failure = error;
    this.closed = true;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(error);
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value)
          return { done: false, value };
        if (this.failure)
          throw this.failure;
        if (this.closed)
          return { done: true, value: undefined };
        return await new Promise((resolve3, reject) => {
          this.waiters.push({ resolve: resolve3, reject });
        });
      }
    };
  }
}

// src/runtime/loopback-web-process.ts
import { spawn as spawn2 } from "child_process";
var MAX_OUTPUT_BYTES = 65536;
async function startSupervisedLoopbackWebApp(options) {
  const child = (options.spawnProcess ?? spawnLoopbackWebProcess)(options.executable, options.args, {
    env: options.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const instance = new SpawnedLoopbackWebApp(options.label, child, options.readinessTimeoutMs, options.shutdownTimeoutMs);
  try {
    await instance.waitUntilReady();
    return instance;
  } catch (error) {
    await instance.release();
    throw error;
  }
}

class SpawnedLoopbackWebApp {
  label;
  child;
  shutdownTimeoutMs;
  healthListeners = new Set;
  exitListeners = new Set;
  exited;
  ready;
  origin = null;
  currentHealth = "starting";
  output = "";
  stopping = false;
  didExit = false;
  settleExit;
  settleReady;
  rejectReady;
  releasePromise = null;
  constructor(label, child, readinessTimeoutMs, shutdownTimeoutMs) {
    this.label = label;
    this.child = child;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    if (!child.stdout || !child.stderr)
      throw new Error(`${label} process pipes were not created`);
    this.exited = new Promise((resolve3) => {
      this.settleExit = resolve3;
    });
    const boot = new Promise((resolve3, reject) => {
      this.settleReady = resolve3;
      this.rejectReady = reject;
    });
    this.ready = withTimeout2(boot, readinessTimeoutMs, `${label} did not report a loopback URL before startup timed out`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.receiveOutput(chunk));
    child.stderr.on("data", (chunk) => this.receiveOutput(chunk));
    child.once("error", (cause) => this.processFailed(new Error(`${label} process could not be started`, { cause })));
    child.once("exit", (code, signal) => this.processExited(code, signal));
  }
  get upstream() {
    if (!this.origin)
      throw new Error(`${this.label} has not reported its loopback URL`);
    return this.origin;
  }
  async waitUntilReady() {
    await this.ready;
  }
  health() {
    return this.currentHealth;
  }
  onHealthChange(listener) {
    this.healthListeners.add(listener);
    return () => {
      this.healthListeners.delete(listener);
    };
  }
  onExit(listener) {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
  async release() {
    if (!this.releasePromise)
      this.releasePromise = this.stop();
    const operation = this.releasePromise;
    try {
      await operation;
    } catch (error) {
      if (this.releasePromise === operation)
        this.releasePromise = null;
      throw error;
    }
  }
  receiveOutput(chunk) {
    this.output = `${this.output}${chunk}`.slice(-MAX_OUTPUT_BYTES);
    if (this.origin || this.didExit)
      return;
    const match = /http:\/\/127\.0\.0\.1:(\d{1,5})(?:\/)?(?=$|[\s"'])/u.exec(this.output);
    if (!match)
      return;
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      return;
    this.origin = `http://127.0.0.1:${port}`;
    this.transition("ready");
    this.settleReady();
  }
  processFailed(error) {
    if (this.didExit)
      return;
    this.didExit = true;
    this.rejectReady(error);
    this.transition("error");
    this.settleExit();
    for (const listener of this.exitListeners)
      listener(error);
  }
  processExited(code, signal) {
    if (this.didExit)
      return;
    this.didExit = true;
    const detail = this.output.trim();
    const error = this.stopping ? undefined : new Error(`${this.label} exited unexpectedly${code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : ""}${detail ? `: ${detail}` : ""}`);
    if (error)
      this.rejectReady(error);
    this.transition(error ? "error" : "stopped");
    this.settleExit();
    for (const listener of this.exitListeners)
      listener(error);
  }
  transition(health) {
    if (this.currentHealth === health)
      return;
    this.currentHealth = health;
    for (const listener of this.healthListeners)
      listener(health);
  }
  async stop() {
    if (this.didExit || this.child.exitCode !== null)
      return;
    this.stopping = true;
    this.child.kill("SIGTERM");
    const exited = await settlesWithin(this.exited, this.shutdownTimeoutMs);
    if (exited || this.didExit || this.child.exitCode !== null)
      return;
    this.child.kill("SIGKILL");
    const killed = await settlesWithin(this.exited, this.shutdownTimeoutMs);
    if (killed || this.didExit || this.child.exitCode !== null)
      return;
    this.transition("error");
    throw new Error(`${this.label} did not exit after SIGKILL`);
  }
}
function spawnLoopbackWebProcess(executable, args, options) {
  return spawn2(executable, [...args], options);
}
async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise((resolve3) => {
        timer = setTimeout(resolve3, timeoutMs, false);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function withTimeout2(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// src/runtime/deepseek-harness-web-process.ts
var DEFAULT_READINESS_TIMEOUT_MS = 30000;
var DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
var DSH_WEB_ARGUMENTS = ["web", "--host", "127.0.0.1", "--port", "0", "--no-open"];
var BRIDGE_ENVIRONMENT_NAMES = ["CONNECT_DSH_BRIDGE_FD_OUT", "CONNECT_DSH_BRIDGE_FD_IN"];
function canonicalDshWebEnvironmentOverrides(home, env) {
  const overrides = { ...env, DSH_HOME: home };
  for (const name of BRIDGE_ENVIRONMENT_NAMES)
    delete overrides[name];
  return Object.freeze(Object.fromEntries(Object.entries(overrides).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}
async function startDshWebApp(options) {
  return await startSupervisedLoopbackWebApp({
    label: "DSH Web",
    executable: options.executable,
    args: [...options.executableArguments ?? [], ...DSH_WEB_ARGUMENTS],
    env: {
      ...process.env,
      ...canonicalDshWebEnvironmentOverrides(options.home, options.env)
    },
    readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ...options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}
  });
}

// src/runtime/executable-identity.ts
import { realpathSync as realpathSync3, statSync as statSync2 } from "fs";
function canonicalExecutableIdentity(executable, productName) {
  let path;
  try {
    path = realpathSync3(executable);
  } catch (error) {
    throw new Error(`${productName} executable identity could not be resolved: ${executable}`, { cause: error });
  }
  let stats;
  try {
    stats = statSync2(path, { bigint: true });
  } catch (error) {
    throw new Error(`${productName} executable identity could not be inspected: ${path}`, { cause: error });
  }
  if (!stats.isFile())
    throw new Error(`${productName} executable is not a regular file: ${path}`);
  return {
    path,
    identity: JSON.stringify({ path, device: stats.dev.toString(), inode: stats.ino.toString() })
  };
}

// src/service/version.ts
var CONNECT_VERSION = "0.1.0-beta.9";

// src/plugin/official/deepseek-harness-manifest.ts
var DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID = "clawling.runtime.deepseek-harness";
var DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID = "deepseek-harness";
var DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY = "deepseek-harness";
var DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID = "deepseek-harness-web";

// src/plugin/official/deepseek-harness-entry.ts
function createDeepSeekHarnessOfficialPluginEntry(options = {}) {
  return {
    activate(context) {
      const installation = context.installationConfiguration;
      context.hostCapabilities.get("runtime-provider").register({
        capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID,
        family: DEEPSEEK_HARNESS_OFFICIAL_RUNTIME_FAMILY,
        create(configuration) {
          const binding = deepSeekHarnessBinding(installation, configuration);
          const adapterOptions = {
            bridgePath: options.runtimeAdapter?.bridgePath ?? fileURLToPath(new URL("./deepseek-harness-bridge.mjs", import.meta.url)),
            bridgeBuild: options.runtimeAdapter?.bridgeBuild ?? `${CONNECT_VERSION}:clawchat-tools-v1`,
            ...options.runtimeAdapter?.createBridge ? { createBridge: options.runtimeAdapter.createBridge } : {},
            ...options.runtimeAdapter?.probeExecutable ? { probeExecutable: options.runtimeAdapter.probeExecutable } : {}
          };
          const adapter = (options.createAdapter ?? createDeepSeekHarnessRuntimeAdapter)(adapterOptions);
          return bridgeDeepSeekHarnessAdapter(adapter, binding);
        }
      });
      const activeHomes = new Map;
      context.hostCapabilities.get("managed-web-app-provider").register(deepSeekHarnessWebProvider(installation, options, activeHomes));
    }
  };
}
function deepSeekHarnessWebProvider(installation, options, activeHomes) {
  const probeExecutable = options.webApp?.probeExecutable ?? requireDshExecutable;
  const start = options.webApp?.start ?? startDshWebApp;
  return {
    capabilityId: DEEPSEEK_HARNESS_WEB_APP_CAPABILITY_ID,
    instanceKey(context) {
      return deepSeekHarnessWebScope(installation, context, probeExecutable).key;
    },
    async acquire(context) {
      const scope = deepSeekHarnessWebScope(installation, context, probeExecutable);
      if (scope.key !== context.instanceKey) {
        throw new Error("DSH Web executable, Home, or Web configuration changed during acquisition");
      }
      const releaseHome = claimDshHome(activeHomes, scope.home, scope.executableIdentity);
      try {
        const instance = await start({
          executable: scope.executable,
          executableArguments: scope.executableArguments,
          home: scope.home,
          env: scope.env
        });
        let released = false;
        return {
          upstream: instance.upstream,
          waitUntilReady: async () => await instance.waitUntilReady(),
          health: () => instance.health(),
          onHealthChange: (listener) => instance.onHealthChange(listener),
          onExit: (listener) => instance.onExit(listener),
          async release() {
            if (released)
              return;
            released = true;
            try {
              await instance.release();
            } finally {
              releaseHome();
            }
          }
        };
      } catch (error) {
        releaseHome();
        throw error;
      }
    }
  };
}
function deepSeekHarnessWebScope(installation, context, probeExecutable) {
  const runtime = context.runtimeConfiguration;
  const configuredEnvironment = runtime.env;
  const configuredExecutable = runtime.executablePathOverride ?? installation.executablePath;
  const probe = probeExecutable(configuredExecutable, configuredEnvironment);
  const executable = canonicalExecutableIdentity(probe.path, "DeepSeek Harness");
  const executableArguments = Object.freeze([...probe.executableArguments ?? []]);
  const home = canonicalDshHome(runtime.homePath, configuredEnvironment);
  const env = canonicalDshWebEnvironmentOverrides(home, configuredEnvironment);
  return {
    key: JSON.stringify({
      executable: executable.identity,
      executableArguments,
      home,
      web: {
        host: "127.0.0.1",
        port: 0,
        openBrowser: false,
        environment: environmentIdentity(env)
      }
    }),
    executable: executable.path,
    executableArguments,
    executableIdentity: executable.identity,
    home,
    env
  };
}
function environmentIdentity(environment) {
  const entries = Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}
function claimDshHome(activeHomes, home, executableIdentity) {
  const active = activeHomes.get(home);
  if (active && active.executableIdentity !== executableIdentity) {
    throw new Error(`DSH Web Home ${home} is already active under a different DeepSeek Harness executable identity`);
  }
  if (active)
    active.instances += 1;
  else
    activeHomes.set(home, { executableIdentity, instances: 1 });
  let released = false;
  return () => {
    if (released)
      return;
    released = true;
    const current = activeHomes.get(home);
    if (!current || current.executableIdentity !== executableIdentity)
      return;
    current.instances -= 1;
    if (current.instances === 0)
      activeHomes.delete(home);
  };
}
function deepSeekHarnessBinding(installation, configuration) {
  const binding = structuredClone(configuration);
  return {
    runtime: {
      pluginId: DEEPSEEK_HARNESS_OFFICIAL_PLUGIN_ID,
      capabilityId: DEEPSEEK_HARNESS_OFFICIAL_CAPABILITY_ID
    },
    runtimeConfig: structuredClone(configuration),
    ...installation.executablePath && !binding.executablePathOverride ? { executablePathOverride: installation.executablePath } : {},
    ...binding
  };
}
function bridgeDeepSeekHarnessAdapter(adapter, binding) {
  const discoverThreads = adapter.discoverThreads?.bind(adapter);
  const discoverAllThreads = adapter.discoverAllThreads?.bind(adapter);
  const discoverArchivedThreads = adapter.discoverArchivedThreads?.bind(adapter);
  return {
    modes: adapter.modes,
    lifecycleCapabilities: adapter.lifecycleCapabilities,
    prepare: adapter.prepare ? async () => await adapter.prepare?.(binding) : undefined,
    modesFor: adapter.modesFor ? (scope) => adapter.modesFor?.(binding, scope) ?? adapter.modes : undefined,
    listModels: adapter.listModels ? async (scope) => await adapter.listModels?.(binding, scope) ?? [] : undefined,
    listSessionOptions: adapter.listSessionOptions ? async (workspace, scope) => await adapter.listSessionOptions?.(binding, workspace, scope) ?? [] : undefined,
    listSkills: adapter.listSkills ? async (workspace, catalogOptions) => await adapter.listSkills?.(binding, workspace, catalogOptions) ?? [] : undefined,
    onSkillsChanged: adapter.onSkillsChanged?.bind(adapter),
    listCommands: adapter.listCommands ? async (workspace, catalogOptions) => await adapter.listCommands?.(binding, workspace, catalogOptions) ?? [] : undefined,
    onCommandsChanged: adapter.onCommandsChanged?.bind(adapter),
    onCatalogsChanged: adapter.onCatalogsChanged?.bind(adapter),
    discoverThreads: discoverThreads ? async (workspace) => await discoverThreads(binding, workspace) : undefined,
    discoverAllThreads: discoverAllThreads ? async () => await discoverAllThreads(binding) : undefined,
    discoverArchivedThreads: discoverArchivedThreads ? async () => await discoverArchivedThreads(binding) : undefined,
    verifyThreadReady: adapter.verifyThreadReady ? async (runtimeThreadId) => await adapter.verifyThreadReady?.(binding, runtimeThreadId) : undefined,
    readActivity: adapter.readActivity ? async (runtimeThreadId) => {
      const snapshot = await adapter.readActivity?.(binding, runtimeThreadId);
      if (!snapshot)
        throw new Error("DeepSeek Harness Runtime Adapter returned no Activity");
      return snapshot;
    } : undefined,
    reconcileInput: adapter.reconcileInput ? async (runtimeThreadId, candidate) => await adapter.reconcileInput?.(binding, runtimeThreadId, candidate) ?? { outcome: "unknown" } : undefined,
    archiveThread: adapter.archiveThread ? async (runtimeThreadId) => await adapter.archiveThread?.(binding, runtimeThreadId) : undefined,
    start: async (context) => await adapter.start(binding, runtimeStartContext(context)),
    close: adapter.close ? async () => await adapter.close?.() : undefined
  };
}
function runtimeStartContext(context) {
  return {
    agentId: context.bindingId,
    chatId: context.chatId,
    sessionId: context.sessionId,
    runtimeSessionId: context.runtimeThreadId,
    onRuntimeSessionId: context.onRuntimeThreadId,
    cacheMedia: context.cacheMedia
  };
}
var deepseek_harness_entry_default = createDeepSeekHarnessOfficialPluginEntry();
export {
  deepseek_harness_entry_default as default,
  createDeepSeekHarnessOfficialPluginEntry
};
