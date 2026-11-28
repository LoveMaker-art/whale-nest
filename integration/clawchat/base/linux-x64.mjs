// @bun
// src/plugin/official/deepseek-harness-entry.ts
import { createHash as createHash2 } from "crypto";
import { fileURLToPath } from "url";

// src/runtime/deepseek-harness-adapter.ts
import { randomUUID as randomUUID2 } from "crypto";
import { realpathSync as realpathSync2, statSync } from "fs";
import { stat as stat2 } from "fs/promises";
import { basename as basename2, resolve as resolve2 } from "path";

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
function dshModelEnvironment(env) {
  const native = { ...env };
  for (const key of ["AGENT_MANAGER_TOKEN", "CLAWCLOUD_TOKEN", "CLAWCHAT_INTERNAL_API_TOKEN", "INTERNAL_AUTH_TOKEN"]) {
    delete native[key];
  }
  return native;
}

// src/runtime/deepseek-harness-process.ts
import { write } from "fs";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join as join2 } from "path";
import { createInterface } from "readline";
import { Readable } from "stream";
import { finished } from "stream/promises";

// src/runtime/deepseek-harness-protocol.ts
var DSH_BRIDGE_PROTOCOL_NAME = "clawchat-connect-dsh-bridge";
var DSH_BRIDGE_PROTOCOL_MAJOR = 2;
var DSH_BRIDGE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
  if (!protocol || typeof protocol !== "object" || protocol.name !== DSH_BRIDGE_PROTOCOL_NAME || typeof protocol.major !== "number" || typeof protocol.build !== "string" || protocol.maxFrameBytes !== undefined && (!Number.isSafeInteger(protocol.maxFrameBytes) || protocol.maxFrameBytes <= 0) || typeof value.home !== "string" || value.profile !== null && typeof value.profile !== "string" || !isCapabilities(value.capabilities)) {
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

// src/runtime/lifecycle-log.ts
var LIFECYCLE_PREFIX = "clawchat-lifecycle ";
var IGNORED_REASONS = [
  "not_addressed",
  "not_owner",
  "muted",
  "oversized",
  "empty_message",
  "command",
  "interaction_response",
  "pending_interaction",
  "recalled",
  "no_turn"
];
var QUEUED_REASONS = ["busy"];
var FAILED_REASONS = [
  "send_failed",
  "model_error",
  "timeout",
  "cancelled",
  "bridge_exit",
  "restart",
  "recovery_gave_up",
  "runtime_error"
];
var EXPIRED_REASONS = ["timeout"];
var LIFECYCLE_REASONS = [
  ...IGNORED_REASONS,
  ...QUEUED_REASONS,
  ...FAILED_REASONS,
  ...EXPIRED_REASONS
];

class MemoryLedger {
  keys = new Set;
  async claim(key) {
    if (this.keys.has(key))
      return false;
    this.keys.add(key);
    return true;
  }
  async has(key) {
    return this.keys.has(key);
  }
}
var STEP_REASONS = {
  ignored: { allowed: new Set(IGNORED_REASONS), fallback: "no_turn" },
  queued: { allowed: new Set(QUEUED_REASONS), fallback: "busy" },
  turn_failed: { allowed: new Set(FAILED_REASONS), fallback: "runtime_error" },
  interaction_expired: { allowed: new Set(EXPIRED_REASONS), fallback: "timeout" }
};
var MAX_FIELD_CHARACTERS = 200;
class LifecycleError extends Error {
  reason;
  constructor(message, reason, options) {
    super(message, options);
    this.name = new.target.name;
    this.reason = reason;
  }
}

class BridgeExitError extends LifecycleError {
  constructor(message, options) {
    super(message, "bridge_exit", options);
  }
}

class BridgeTimeoutError extends LifecycleError {
  constructor(message, options) {
    super(message, "timeout", options);
  }
}
class ShutdownError extends Error {
  name = "ShutdownError";
}
function redactLifecycleError(value) {
  return errorClass(value);
}
function errorClass(value) {
  let raw;
  if (typeof value === "string")
    raw = value;
  else if (value && typeof value === "object") {
    const record = value;
    if (typeof record.code === "string" && record.code)
      raw = record.code;
    else if (typeof record.name === "string" && record.name)
      raw = record.name;
  }
  if (!raw)
    return;
  const cleaned = raw.replace(/(bearer|basic)\s+\S+/giu, "$1 [redacted]").replace(/(?:sk|dsh|tok|key|secret|pat|ghp)[-_][A-Za-z0-9_-]{8,}/giu, "[redacted]").replace(/(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{24,}/gu, "[redacted]").replace(/[^A-Za-z0-9_.:[\] -]/gu, "").slice(0, MAX_FIELD_CHARACTERS);
  return cleaned || undefined;
}
function boundedId(value) {
  return value.slice(0, MAX_FIELD_CHARACTERS);
}

class LifecycleLog {
  runtime;
  writeLine;
  now;
  ledger;
  seen = new Set;
  started = new Set;
  tail = Promise.resolve();
  constructor(options = {}) {
    const runtime = options.runtime ?? "dsh";
    this.runtime = typeof runtime === "function" ? runtime : () => runtime;
    this.writeLine = options.write ?? ((line) => {
      process.stdout.write(`${line}
`);
    });
    this.now = options.now ?? (() => new Date);
    this.ledger = options.ledger ?? new MemoryLedger;
  }
  static silent() {
    const log = new LifecycleLog({ write: () => {
      return;
    } });
    log.active = false;
    return log;
  }
  active = true;
  seenInProcess(messageId) {
    return this.seen.has(messageId);
  }
  received(message) {
    this.seen.add(message.messageId);
    this.record(message.messageId, message.chatId, { step: "received" }, false);
  }
  ignored(ids, chat, reason) {
    for (const msg of ids)
      this.record(msg, chat, { step: "ignored", reason }, true);
  }
  queued(ids, chat, reason) {
    for (const msg of ids)
      this.record(msg, chat, { step: "queued", reason }, false);
  }
  turnStarted(ids, turn, chat) {
    for (const msg of ids) {
      if (this.started.has(msg))
        continue;
      this.started.add(msg);
      this.record(msg, chat, { step: "turn_started", turn }, false);
    }
  }
  replySent(message, fields) {
    this.record(message.messageId, message.chatId, {
      step: "reply_sent",
      ...fields.turn ? { turn: fields.turn } : {},
      ...fields.reply ? { reply: fields.reply } : {}
    }, false, fields.at);
  }
  turnFinished(ids, turn, chat) {
    for (const msg of ids)
      this.record(msg, chat, { step: "turn_finished", turn }, true);
  }
  turnFailed(ids, turn, chat, failure) {
    for (const msg of ids) {
      this.seen.add(msg);
      this.record(msg, chat, {
        step: "turn_failed",
        ...turn ? { turn } : {},
        reason: failure.reason,
        ...failure.error ? { error: failure.error } : {}
      }, true);
    }
  }
  interactionPending(msg, turn, chat) {
    this.turnStarted([msg], turn, chat);
    this.record(msg, chat, { step: "interaction_pending", turn }, false);
  }
  interactionExpired(msg, turn, chat) {
    this.record(msg, chat, { step: "interaction_expired", turn, reason: "timeout" }, false);
  }
  record(msg, chat, fields, terminal, at) {
    const ts = (at ?? this.now()).toISOString();
    const task = async () => {
      let label;
      try {
        label = this.runtime();
      } catch {
        label = undefined;
      }
      if (!label)
        return;
      const receivedKey = `lifecycle:received:${msg}`;
      const terminalKey = `lifecycle:terminal:${msg}`;
      if (fields.step === "received") {
        if (await this.ledger.claim(receivedKey))
          this.write(label, ts, msg, chat, fields);
        return;
      }
      if (await this.ledger.claim(receivedKey))
        this.write(label, ts, msg, chat, { step: "received" });
      if (terminal) {
        if (await this.ledger.claim(terminalKey))
          this.write(label, ts, msg, chat, fields);
      } else if (!await this.ledger.has(terminalKey)) {
        this.write(label, ts, msg, chat, fields);
      }
    };
    this.tail = this.tail.then(task).catch(() => {
      return;
    });
  }
  async flush() {
    await this.tail;
  }
  write(runtime, ts, msg, chat, fields) {
    const extra = fields;
    let reason = extra.reason;
    if (reason !== undefined && (fields.step === "ignored" || fields.step === "queued" || fields.step === "turn_failed" || fields.step === "interaction_expired")) {
      const rule = STEP_REASONS[fields.step];
      if (!rule.allowed.has(reason))
        reason = rule.fallback;
    }
    const record = {
      v: 1,
      ts,
      runtime,
      step: fields.step,
      msg: boundedId(msg),
      ...extra.reply ? { reply: boundedId(extra.reply) } : {},
      ...extra.turn ? { turn: boundedId(extra.turn) } : {},
      chat: boundedId(chat),
      ...reason ? { reason } : {},
      ...extra.error ? { error: redactLifecycleError(extra.error) } : {}
    };
    try {
      this.writeLine(`${LIFECYCLE_PREFIX}${JSON.stringify(record)}`);
    } catch {}
  }
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
    `        maxFrameBytes: ${DSH_BRIDGE_MAX_FRAME_BYTES}`,
    ""
  ].join(`
`));
  let child;
  try {
    child = Bun.spawn([
      options.executable,
      ...options.executableArguments ?? [],
      ...options.profile ? ["--profile", options.profile] : [],
      "--patch",
      overlayPath
    ], {
      cwd: options.cwd,
      env: dshModelEnvironment({
        ...process.env,
        ...options.env,
        DSH_HOME: options.home,
        CONNECT_DSH_BRIDGE_FD_OUT: "3",
        CONNECT_DSH_BRIDGE_FD_IN: "4"
      }),
      stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"]
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
  failureListeners = new Set;
  pending = new Map;
  output;
  writeTail = Promise.resolve();
  writeAbort = new AbortController;
  exited;
  requestSequence = 0;
  closing = false;
  failure = null;
  constructor(child, temporaryDirectory, hello, requestTimeoutMs, stopTimeoutMs, stderr, processClosed) {
    this.child = child;
    this.temporaryDirectory = temporaryDirectory;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.stderr = stderr;
    this.hello = hello;
    this.output = child.stdio[4];
    this.exited = processClosed.then((code) => {
      if (!this.closing) {
        const detail = this.stderr.text.trim();
        this.fail(new BridgeExitError(`DeepSeek Harness process exited unexpectedly (${child.signalCode ? `signal ${child.signalCode}` : `code ${code}`})${detail ? `: ${detail}` : ""}`));
      }
    });
  }
  static async create(child, temporaryDirectory, options) {
    const input = Readable.from(Bun.file(child.stdio[3]).stream());
    const stderrStream = Readable.from(child.stderr);
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
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > DSH_BRIDGE_MAX_FRAME_BYTES) {
        const error = new BridgeExitError(`DeepSeek Harness Bridge emitted an oversized frame (${lineBytes} bytes; limit ${DSH_BRIDGE_MAX_FRAME_BYTES})`);
        bridge?.fail(error);
        rejectHello(error);
        child.kill("SIGTERM");
        return;
      }
      let frame;
      try {
        frame = parseDshBridgeFrame(line);
      } catch (cause) {
        const error = new BridgeExitError("DeepSeek Harness Bridge emitted a malformed frame", { cause });
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
    const processClosed = child.exited.then(async (code) => {
      await Promise.allSettled([finished(input), finished(stderrStream)]);
      return code;
    });
    processClosed.then((code) => {
      if (bridge)
        return;
      const detail = stderr.text.trim();
      rejectHello(new Error(`DeepSeek Harness Profile boot failed (code ${code})${detail ? `: ${detail}` : ""}`));
    });
    input.on("error", (cause) => {
      const error = new BridgeExitError("DeepSeek Harness Bridge pipe could not be read", { cause });
      bridge?.fail(error);
      rejectHello(error);
      child.kill("SIGTERM");
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
      throw new Error(`DeepSeek Harness Bridge protocol major ${hello.protocol.major} is incompatible with ${DSH_BRIDGE_PROTOCOL_MAJOR}; the Runtime Plugin's Adapter and Bridge must come from the same release`);
    }
    bridge = new SpawnedDshBridge(child, temporaryDirectory, hello, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, stderr, processClosed);
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
    const encodedBytes = Buffer.byteLength(encoded);
    const limit = Math.min(DSH_BRIDGE_MAX_FRAME_BYTES, this.hello.protocol.maxFrameBytes ?? DSH_BRIDGE_MAX_FRAME_BYTES);
    if (encodedBytes > limit) {
      throw new Error(`DeepSeek Harness Bridge request ${method} exceeds the frame limit (${encodedBytes} > ${limit} bytes)`);
    }
    const reply = new Promise((resolve2, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeTimeoutError(`DeepSeek Harness Bridge request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve2, reject, timeout });
    });
    reply.catch(() => {
      return;
    });
    const signal = AbortSignal.any([this.writeAbort.signal, AbortSignal.timeout(timeoutMs)]);
    const writeRequest = this.writeTail.then(() => writePipe(this.child, this.output, Buffer.from(encoded), signal));
    this.writeTail = writeRequest.catch((cause) => {
      this.fail(new BridgeExitError(`DeepSeek Harness Bridge request could not be written: ${method}`, { cause }));
    });
    await this.writeTail;
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
  onFailure(listener) {
    if (this.failure) {
      listener(this.failure);
      return () => {
        return;
      };
    }
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
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
        this.child.stdin.end();
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
      this.fail(new ShutdownError("DeepSeek Harness Bridge closed"));
      await rm(this.temporaryDirectory, { recursive: true, force: true });
    }
  }
  receive(frame) {
    if (frame.type === "hello") {
      this.fail(new BridgeExitError("DeepSeek Harness Bridge emitted more than one hello frame"));
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
    const first = !this.failure;
    this.failure ??= error;
    this.writeAbort.abort(this.failure);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.failure);
    }
    this.pending.clear();
    if (first)
      for (const listener of [...this.failureListeners])
        listener(this.failure);
    this.failureListeners.clear();
  }
}
async function terminateDshProcess(child, timeoutMs) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    try {
      await withTimeout(child.exited, timeoutMs, "DSH termination timed out");
    } catch {
      child.kill("SIGKILL");
      await withTimeout(child.exited, timeoutMs, "DSH process could not be reaped");
    }
  }
}
async function writePipe(child, fd, buffer, signal) {
  for (let offset = 0;offset < buffer.length; ) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new BridgeExitError("DeepSeek Harness Bridge pipe closed");
    offset += await new Promise((resolve2, reject) => {
      write(fd, buffer, offset, buffer.length - offset, null, (error, written) => {
        if (error?.code === "EAGAIN")
          setTimeout(() => resolve2(0), 2);
        else if (error)
          reject(error);
        else
          resolve2(written);
      });
    });
  }
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

// src/runtime/dsh-inbound-media.ts
import { createHash, randomUUID } from "crypto";
import { constants, createReadStream } from "fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm as rm2, stat } from "fs/promises";
import { basename, extname, join as join3 } from "path";

// src/path-containment.ts
import { isAbsolute, relative } from "path";
function isPathWithin(root, candidate, options) {
  const nested = relative(root, candidate);
  if (nested === "")
    return options.allowEqual;
  return nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\") && !isAbsolute(nested);
}

// src/runtime/media-cache.ts
var MAX_RUNTIME_MEDIA_BYTES = 100 * 1024 * 1024;
var MAX_RUNTIME_MEDIA_CACHE_BYTES = 512 * 1024 * 1024;
var RUNTIME_MEDIA_CACHE_TTL_MS = 15 * 24 * 60 * 60 * 1000;

// src/runtime/dsh-inbound-media.ts
var DSH_INBOX_DIRECTORY = "clawchat-inbox";
var DSH_MAX_INBOUND_FILE_BYTES = MAX_RUNTIME_MEDIA_BYTES;
var DSH_MAX_INBOUND_FILES = 10;
var DSH_INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
var DSH_INBOX_PRUNE_BATCH = 50;
var MAX_NAME_BYTES = 120;
function sanitizeInboxName(rawName, kind, mime) {
  const lastSegment = (rawName ?? "").split(/[\\/]/u).pop() ?? "";
  let name = lastSegment.replace(/[\u0000-\u001f\u007f]/gu, "").replace(/[^\p{L}\p{N}._ -]/gu, "_").trim().replace(/^\.+/u, "");
  if (name === "" || name === "_")
    name = "";
  if (name === "")
    name = `${kind}${mime ? extensionForMime(mime) : ""}`;
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const budget = MAX_NAME_BYTES - Buffer.byteLength(extension);
  let trimmed = stem;
  while (Buffer.byteLength(trimmed) > budget)
    trimmed = trimmed.slice(0, -1);
  return `${trimmed || kind}${extension}`;
}
function extensionForMime(mime) {
  const table = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "application/pdf": ".pdf",
    "text/plain": ".txt"
  };
  return table[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "";
}
function validateExactInboxSegment(value) {
  if (!value || value.length > 80)
    return null;
  if (value.startsWith(".") || value.includes(".."))
    return null;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(value))
    return null;
  return value;
}
function safeSegment(value) {
  if (value && validateExactInboxSegment(value))
    return value;
  const cleaned = (value ?? "").replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").replace(/\.{2,}/gu, "_");
  return cleaned.slice(0, 80) || `turn-${randomUUID()}`;
}
async function stageIntoWorkspaceInbox(workspace, messageId, items) {
  const result = { staged: [], dropped: [] };
  if (items.length === 0)
    return result;
  const root = await realpath(workspace);
  const inbox = join3(root, DSH_INBOX_DIRECTORY);
  await ensureRealDirectory(root, inbox);
  const fallbackSegment = safeSegment(messageId);
  const targetDirectories = new Map;
  const itemSegments = [];
  for (const [index, { media }] of items.entries()) {
    if (index >= DSH_MAX_INBOUND_FILES)
      break;
    const segment = media.sourceMessageId ? safeSegment(media.sourceMessageId) : fallbackSegment;
    itemSegments.push(segment);
    if (targetDirectories.has(segment))
      continue;
    const directory = join3(inbox, segment);
    await ensureRealDirectory(root, directory);
    const real = await realpath(directory);
    if (!isPathWithin(root, real, { allowEqual: false })) {
      throw new Error("DeepSeek Harness inbox escaped the Workspace");
    }
    targetDirectories.set(segment, { real, used: new Set });
  }
  await pruneExpiredInbox(new Set([...targetDirectories.values()].map((entry) => entry.real)), inbox);
  for (const [index, { media, sourcePath }] of items.entries()) {
    const label = sanitizeInboxName(media.name, media.kind, media.mime);
    if (index >= DSH_MAX_INBOUND_FILES) {
      result.dropped.push({ name: label, reason: `more than ${DSH_MAX_INBOUND_FILES} attachments in one turn` });
      continue;
    }
    const target = targetDirectories.get(itemSegments[index] ?? fallbackSegment);
    if (!target) {
      result.dropped.push({ name: label, reason: "could not be saved" });
      continue;
    }
    try {
      const details = await stat(sourcePath);
      if (!details.isFile())
        throw new DropError("not a regular file");
      if (details.size > DSH_MAX_INBOUND_FILE_BYTES)
        throw new DropError("larger than 100 MiB");
      const path = await copyIntoInbox(target.real, sourcePath, label, details.size, target.used);
      result.staged.push({
        path,
        name: basename(path),
        mime: media.mime ?? "application/octet-stream",
        kind: media.kind,
        size: details.size
      });
    } catch (error) {
      result.dropped.push({ name: label, reason: error instanceof DropError ? error.message : "could not be saved" });
    }
  }
  return result;
}
async function pruneExpiredInbox(currentDirectories, inbox, now = Date.now()) {
  try {
    const realInbox = await realpath(inbox);
    const entries = (await readdir(realInbox)).filter((name) => !currentDirectories.has(join3(realInbox, name))).slice(0, DSH_INBOX_PRUNE_BATCH);
    for (const name of entries) {
      const directory = join3(realInbox, name);
      try {
        const details = await lstat(directory);
        if (details.isSymbolicLink() || !details.isDirectory())
          continue;
        let newest = details.mtimeMs;
        for (const child of await readdir(directory)) {
          newest = Math.max(newest, (await lstat(join3(directory, child))).mtimeMs);
        }
        if (now - newest > DSH_INBOX_RETENTION_MS)
          await rm2(directory, { recursive: true, force: true });
      } catch {
        console.warn("DeepSeek Harness inbox cleanup skipped an entry");
      }
    }
  } catch {
    console.warn("DeepSeek Harness inbox cleanup failed");
  }
}

class DropError extends Error {
}
async function copyIntoInbox(directory, sourcePath, name, size, used) {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let sourceDigest;
  for (let attempt = 1;attempt <= 1000; attempt += 1) {
    const candidate = attempt === 1 ? name : `${stem}-${attempt}${extension}`;
    if (used.has(candidate.toLowerCase()))
      continue;
    const target = join3(directory, candidate);
    try {
      await copyFile(sourcePath, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      const existing = await lstat(target).catch(() => null);
      if (existing?.isFile() && existing.size === size) {
        sourceDigest ??= await sha256(sourcePath);
        if (await sha256(target) === sourceDigest) {
          used.add(candidate.toLowerCase());
          return target;
        }
      }
      continue;
    }
    const final = await realpath(target).catch(() => null);
    if (!final || !isPathWithin(directory, final, { allowEqual: false })) {
      await rm2(target, { force: true }).catch(() => {
        return;
      });
      throw new DropError("could not be saved safely");
    }
    used.add(candidate.toLowerCase());
    return final;
  }
  throw new DropError("could not be saved");
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk);
  return hash.digest("hex");
}
async function ensureRealDirectory(root, path) {
  const existing = await lstat(path).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error("DeepSeek Harness inbox path is not a plain directory inside the Workspace");
    }
  } else {
    await mkdir(path, { mode: 448 });
  }
  if (!isPathWithin(root, await realpath(path), { allowEqual: false }))
    throw new Error("DeepSeek Harness inbox escaped the Workspace");
}
function inboxPathNote(files, dropped = []) {
  if (files.length === 0 && dropped.length === 0)
    return "";
  const lines = [
    ...files.map((file) => `Attachment ${file.name}: ${file.path} (${file.mime}, ${file.size} bytes). Use an available analysis tool if supported; do not claim to have analyzed it without doing so.`),
    ...dropped.map((file) => `Attachment ${file.name} was not received: ${file.reason}.`)
  ];
  return `

<clawchat_attachments>
${lines.join(`
`)}
</clawchat_attachments>`;
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
    lifecycleLabel: "dsh",
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
      await harness.client.request("history", {
        sessionId: runtimeThreadId,
        headerOnly: true
      });
    },
    async readActivity(binding, runtimeThreadId) {
      const harness = await ensurePrepared(binding);
      const recent = await harness.client.request("history", {
        sessionId: runtimeThreadId,
        lastTurns: DSH_ACTIVITY_WINDOW_TURNS,
        maxBytes: DSH_HISTORY_WINDOW_BYTES
      });
      const snapshot = projectDshHistory(runtimeThreadId, recent.events);
      return recent.complete ? snapshot : { ...snapshot, completeness: "partial", limitations: ["correlation", "ordering"] };
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
  selectedModel = null;
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
    if (input.command && (input.media?.length ?? 0) > 0) {
      throw new Error("DeepSeek Harness Runtime Commands do not accept attachment input");
    }
    if (input.model)
      this.selectedModel = input.model;
    const { images, note } = await stageDshAttachments(input, this.context, async () => await this.imageCapableModel());
    const runtimeThreadId = await this.ensureThread(input);
    if (input.model) {
      await this.client.request("selectModel", {
        sessionId: runtimeThreadId,
        model: dshModelSelection(input.model, input.reasoningEffort)
      });
    }
    const projector = new DshActivityProjector(runtimeThreadId);
    for (const event of await readDshLatestTurn(this.client, runtimeThreadId))
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
    const offFailure = this.client.onFailure?.((error) => queue.fail(error));
    try {
      if (input.command) {
        await this.executeCommand(input, runtimeThreadId, queue);
      } else {
        const inputId = input.turnId ?? `connect-${randomUUID2()}`;
        const baseInput = input.turnOrigin === "clawchat" ? dshPromptInput(input.prompt) : { text: input.prompt };
        const nativeInput = note ? { ...baseInput, text: `${baseInput.text}${note}` } : baseInput;
        await this.client.request("prompt", {
          sessionId: runtimeThreadId,
          inputId,
          inputOrigin: input.turnOrigin ?? "client",
          ...nativeInput,
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
      offFailure?.();
      if (this.active?.queue === queue)
        this.active = null;
    }
  }
  async imageCapableModel() {
    if (!this.client.hello.capabilities.imageInput)
      return null;
    const models = await this.client.request("models", {});
    const selected = this.selectedModel;
    const model = selected ? models.find((entry) => entry.provider === selected.provider && entry.id === selected.model) : models.find((entry) => entry.isDefault === true);
    return model?.inputModalities?.includes("image") && model.imageLimits ? model : null;
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
        sessionId: this.runtimeThreadId
      });
      if (resumed.header.cwd !== cwd) {
        throw new Error("DeepSeek Harness resumed the Session with a different Workspace");
      }
      return resumed.sessionId;
    }
    const sessionId = `clawchat-${randomUUID2()}`;
    const model = input.model ? dshModelSelection(input.model, input.reasoningEffort) : undefined;
    const created = await this.client.request("create", {
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
      id: `dsh:${runtimeThreadId}:command:${input.turnId ?? randomUUID2()}`,
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
    const activities = this.project(event, source);
    const truncation = event.truncated;
    if (truncation?.truncated !== true)
      return activities;
    if (event.type === "assistant/message" && truncation.placeholder === true && activities.length === 0) {
      const data = eventData(event);
      const turn = integerValue(data.turn, this.currentTurn);
      const id = `dsh:${this.sessionId}:assistant:${turn}:${integerValue(data.step, 0)}`;
      activities.push(this.replace({
        id,
        position: this.positions.get(id) ?? this.position(id, turn),
        parentId: null,
        kind: "assistant",
        text: "",
        state: "complete",
        source,
        data: { nativeSeq: event.seq, nativeType: event.type, outputKind: "assistant" }
      }));
      this.latestAssistantByTurn.set(turn, id);
    }
    for (const activity of activities)
      markTruncated(activity, truncation);
    return activities;
  }
  project(event, source) {
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
var DSH_ACTIVITY_WINDOW_TURNS = 5;
var DSH_HISTORY_WINDOW_BYTES = 2 * 1024 * 1024;
var DSH_HISTORY_MAX_WINDOWS = 8;
async function walkDshHistoryBackwards(client, params, visit) {
  let beforeSeq;
  for (let request = 0;request < DSH_HISTORY_MAX_WINDOWS; request++) {
    const page = await client.request("history", {
      ...params,
      maxBytes: DSH_HISTORY_WINDOW_BYTES,
      ...beforeSeq === undefined ? {} : { beforeSeq }
    });
    if (visit(page) === true)
      return { complete: page.complete };
    const next = page.nextBeforeSeq ?? null;
    if (next === null || page.events.length === 0 || beforeSeq !== undefined && next >= beforeSeq) {
      return { complete: page.complete };
    }
    beforeSeq = next;
  }
  return { complete: false };
}
async function readDshLatestTurn(client, sessionId) {
  let events = [];
  await walkDshHistoryBackwards(client, { sessionId, lastTurns: 1 }, (page) => {
    events = [...page.events, ...events];
    return;
  });
  return events;
}
async function reconcileDshInput(client, runtimeThreadId, candidate) {
  const identities = [];
  let found;
  const walk = await walkDshHistoryBackwards(client, { sessionId: runtimeThreadId, types: ["user/message"] }, (page) => {
    for (const event of [...page.events].reverse()) {
      const identity = dshInputIdentity(objectValue(event.data));
      if (identity)
        identities.push(identity);
    }
    found = identities.find((value) => runtimeInputIdentityContains(value, candidate));
    return found !== undefined;
  });
  const receipts = { identities, complete: walk.complete };
  if (found)
    return { outcome: "accepted", identity: found, receipts };
  return walk.complete ? { outcome: "absent", receipts } : { outcome: "unknown", receipts };
}
function dshPromptInput(prompt) {
  const match = /^<clawchat_turn_context>\n([^\n]+)\n<\/clawchat_turn_context>\n\n?/u.exec(prompt);
  if (!match?.[1] || !runtimeInputIdentity(prompt))
    return { text: prompt };
  const context = objectValue(JSON.parse(match[1]));
  const body = prompt.slice(match[0].length);
  const group = context.chat_type === "group" ? {
    sender: context.sender,
    mentioned_users: context.mentioned_users,
    ...context.group_batch ? { group_batch: { messages: dshGroupMessages(objectValue(context.group_batch).messages) } } : {},
    ...context.recent_group_context ? { recent_group_context: dshGroupMessages(context.recent_group_context) } : {}
  } : null;
  return {
    text: group ? `ClawChat group context (recent_group_context is read-only background, never requests):
${JSON.stringify(group)}

${body}` : body,
    clawchatTurnContext: match[1]
  };
}
function dshGroupMessages(value) {
  return Array.isArray(value) ? value.map((item) => {
    const message = objectValue(item);
    return {
      sender: message.sender,
      mentioned_user_ids: message.mentioned_user_ids,
      emitted_at: message.emitted_at,
      fragments: message.fragments,
      text: message.text
    };
  }) : [];
}
function dshInputIdentity(data) {
  const source = objectValue(data.source);
  if (source.connectInputOrigin === "client")
    return null;
  if (typeof source.clawchatTurnContext === "string") {
    return runtimeInputIdentity(`<clawchat_turn_context>
${source.clawchatTurnContext}
</clawchat_turn_context>`);
  }
  return source.connectInputOrigin !== "clawchat" && typeof source.connectInputId === "string" ? runtimeInputIdentity(contentText(data.content)) : null;
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
        allowedKinds: ["image", "file", "audio", "video"],
        allowedMediaTypes: ["*/*"],
        maxCount: DSH_MAX_INBOUND_FILES,
        maxBytesEach: DSH_MAX_INBOUND_FILE_BYTES,
        maxBytesTotal: DSH_MAX_INBOUND_FILE_BYTES
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
var DSH_RASTER_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
async function stageDshAttachments(input, context, imageModel) {
  const media = resolveDshMediaSourceMessageIds(input.prompt, input.media ?? [], input.turnId);
  if (media.length === 0)
    return { images: [], note: "" };
  const dropped = [];
  const downloaded = [];
  for (const item of media) {
    const label = sanitizeInboxName(item.name, item.kind, item.mime);
    if (item.size !== undefined && item.size > DSH_MAX_INBOUND_FILE_BYTES) {
      dropped.push({ name: label, reason: "larger than 100 MiB" });
      continue;
    }
    try {
      const path = context.cacheMedia ? await context.cacheMedia(item, input.trustedMediaOrigins) : item.stagedPath;
      if (!path)
        throw new Error("staging unavailable");
      downloaded.push({ item, path: resolve2(path) });
    } catch {
      dropped.push({ name: label, reason: "download failed" });
    }
  }
  const limits = downloaded.some(({ item }) => item.kind === "image") ? (await imageModel())?.imageLimits ?? null : null;
  const images = [];
  const staged = [];
  let imageBytes = 0;
  for (const { item, path: sourcePath } of downloaded) {
    const mime = item.mime?.toLowerCase();
    const size = limits && item.kind === "image" ? (await stat2(sourcePath)).size : 0;
    const native = limits !== null && item.kind === "image" && mime !== undefined && DSH_RASTER_IMAGE_TYPES.includes(mime) && limits.mediaTypes.includes(mime) && images.length < limits.maxImagesPerMessage && size <= limits.maxImageBytes && imageBytes + size <= limits.maxMessageImageBytes;
    if (native) {
      imageBytes += size;
      images.push({ path: sourcePath, mediaType: mime, ...item.name ? { name: basename2(item.name) } : {} });
    } else
      staged.push({ media: item, sourcePath });
  }
  const result = await stageIntoWorkspaceInbox(canonicalWorkspace(input.workspace), input.turnId, staged);
  return { images, note: inboxPathNote(result.staged, [...dropped, ...result.dropped]) };
}
function resolveDshMediaSourceMessageIds(prompt, media, fallbackTurnId) {
  if (media.length === 0)
    return [];
  const batchSlots = extractGroupBatchMediaSlots(prompt);
  const consumed = new Set;
  return media.map((item) => {
    if (item.sourceMessageId) {
      const idx = batchSlots.findIndex((slot, index) => !consumed.has(index) && slot.messageId === item.sourceMessageId && slot.kind === item.kind && slot.url === item.url);
      if (idx >= 0)
        consumed.add(idx);
      return item;
    }
    if (batchSlots.length > 0) {
      let idx = batchSlots.findIndex((slot, index) => !consumed.has(index) && slot.kind === item.kind && slot.url === item.url);
      if (idx < 0) {
        idx = batchSlots.findIndex((slot, index) => !consumed.has(index) && slot.url === item.url);
      }
      if (idx >= 0) {
        consumed.add(idx);
        const slot = batchSlots[idx];
        if (slot)
          return { ...item, sourceMessageId: slot.messageId };
      }
    }
    return fallbackTurnId ? { ...item, sourceMessageId: fallbackTurnId } : item;
  });
}
function extractGroupBatchMediaSlots(prompt) {
  const match = /^<clawchat_turn_context>\n([^\n]+)\n<\/clawchat_turn_context>/u.exec(prompt);
  if (!match?.[1])
    return [];
  try {
    const context = objectValue(JSON.parse(match[1]));
    const messages = objectValue(context.group_batch).messages;
    if (!Array.isArray(messages))
      return [];
    const slots = [];
    for (const rawEntry of messages) {
      const entry = objectValue(rawEntry);
      const messageId = typeof entry.message_id === "string" ? entry.message_id : "";
      if (!messageId || !Array.isArray(entry.fragments))
        continue;
      for (const rawFragment of entry.fragments) {
        const fragment = objectValue(rawFragment);
        const kind = typeof fragment.kind === "string" ? fragment.kind : "";
        const url = typeof fragment.url === "string" ? fragment.url : "";
        if ((kind === "image" || kind === "file" || kind === "audio" || kind === "video") && url) {
          slots.push({ messageId, kind, url });
        }
      }
    }
    return slots;
  } catch {
    return [];
  }
}
function requireSelectionName(id, name, prefix) {
  if (id !== `${prefix}${name}`)
    throw new Error(`DeepSeek Harness selection is stale: ${name}`);
  return name;
}
function messageActivity(sessionId, event, data, turn, source) {
  const text = contentText(data.content);
  const inputIdentity = dshInputIdentity(data);
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
function markTruncated(activity, truncation) {
  const notice = truncation.notice;
  const visible = activity.kind === "tool" || activity.kind === "assistant" || activity.kind === "unknown";
  const alreadyShown = truncation.fields.some((field) => field.notice && activity.text.includes(field.notice));
  if (notice && visible && !alreadyShown && !activity.text.includes(notice)) {
    activity.text = activity.text ? `${activity.text}
${notice}` : notice;
  }
  activity.data = {
    ...activity.data ?? {},
    truncated: {
      originalBytes: truncation.originalBytes,
      fields: truncation.fields.length + (truncation.omittedFields ?? 0),
      placeholder: truncation.placeholder === true
    }
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
import { spawn } from "child_process";
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
  return spawn(executable, [...args], options);
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
    env: dshModelEnvironment({
      ...process.env,
      ...canonicalDshWebEnvironmentOverrides(options.home, options.env)
    }),
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
  return `sha256:${createHash2("sha256").update(JSON.stringify(entries)).digest("hex")}`;
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
    lifecycleLabel: adapter.lifecycleLabel,
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
