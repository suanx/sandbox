var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/defaults.ts
var SDK_VERSION, API_URL, API_KEY, NAMESPACE, SANDBOX_PROXY_URL, DEFAULT_HTTP_TIMEOUT_MS, MAX_RETRIES, RETRY_BACKOFF_MS, RETRYABLE_STATUS_CODES;
var init_defaults = __esm({
  "src/defaults.ts"() {
    "use strict";
    SDK_VERSION = "0.4.49";
    API_URL = process.env.TENSORLAKE_API_URL ?? "https://api.tensorlake.ai";
    API_KEY = process.env.TENSORLAKE_API_KEY ?? void 0;
    NAMESPACE = process.env.INDEXIFY_NAMESPACE ?? "default";
    SANDBOX_PROXY_URL = process.env.TENSORLAKE_SANDBOX_PROXY_URL ?? "https://sandbox.tensorlake.ai";
    DEFAULT_HTTP_TIMEOUT_MS = 3e4;
    MAX_RETRIES = 3;
    RETRY_BACKOFF_MS = 500;
    RETRYABLE_STATUS_CODES = /* @__PURE__ */ new Set([429, 502, 503, 504]);
  }
});

// src/errors.ts
var SandboxException, SandboxError, SandboxConnectionError, SandboxNotFoundError, PoolNotFoundError, PoolInUseError, RemoteAPIError, RequestNotFinishedError, RequestFailedError, RequestExecutionError;
var init_errors = __esm({
  "src/errors.ts"() {
    "use strict";
    SandboxException = class extends Error {
      constructor(message) {
        super(message);
        this.name = "SandboxException";
      }
    };
    SandboxError = class extends SandboxException {
      constructor(message) {
        super(message);
        this.name = "SandboxError";
      }
    };
    SandboxConnectionError = class extends SandboxError {
      constructor(message) {
        super(`Connection error: ${message}`);
        this.name = "SandboxConnectionError";
      }
    };
    SandboxNotFoundError = class extends SandboxError {
      sandboxId;
      constructor(sandboxId) {
        super(`Sandbox not found: ${sandboxId}`);
        this.name = "SandboxNotFoundError";
        this.sandboxId = sandboxId;
      }
    };
    PoolNotFoundError = class extends SandboxError {
      poolId;
      constructor(poolId) {
        super(`Sandbox pool not found: ${poolId}`);
        this.name = "PoolNotFoundError";
        this.poolId = poolId;
      }
    };
    PoolInUseError = class extends SandboxError {
      poolId;
      constructor(poolId, message) {
        const base = `Cannot delete pool ${poolId}: pool is in use`;
        super(message ? `${base} - ${message}` : base);
        this.name = "PoolInUseError";
        this.poolId = poolId;
      }
    };
    RemoteAPIError = class extends SandboxError {
      statusCode;
      responseMessage;
      constructor(statusCode, message) {
        super(`API error (status ${statusCode}): ${message}`);
        this.name = "RemoteAPIError";
        this.statusCode = statusCode;
        this.responseMessage = message;
      }
    };
    RequestNotFinishedError = class extends Error {
      constructor() {
        super("Request has not finished yet");
        this.name = "RequestNotFinishedError";
      }
    };
    RequestFailedError = class extends Error {
      failure;
      constructor(failure) {
        super(`Request failed: ${failure}`);
        this.name = "RequestFailedError";
        this.failure = failure;
      }
    };
    RequestExecutionError = class extends Error {
      functionName;
      constructor(message, functionName) {
        super(
          functionName ? `Request error in ${functionName}: ${message}` : message
        );
        this.name = "RequestExecutionError";
        this.functionName = functionName;
      }
    };
  }
});

// src/http.ts
import {
  Agent,
  fetch as undiciFetch,
  setGlobalDispatcher
} from "undici";
function withTraceId(value, traceId) {
  if (value == null) {
    return { traceId };
  }
  return Object.assign(value, { traceId });
}
function hasHeader(headers, name) {
  const lowered = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lowered);
}
function normalizeRequestBody(body) {
  if (body == null) {
    return void 0;
  }
  if (body instanceof Uint8Array) {
    return Uint8Array.from(body).buffer;
  }
  return body;
}
function throwMappedError(status, body, path2) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed.message) message = parsed.message;
    else if (parsed.error) message = parsed.error;
  } catch {
  }
  if (status === 404) {
    if (path2.includes("sandbox-pools") || path2.includes("pools")) {
      const match = path2.match(/sandbox-pools\/([^/]+)/);
      if (match) throw new PoolNotFoundError(match[1]);
    }
    if (path2.includes("sandboxes")) {
      const match = path2.match(/sandboxes\/([^/]+)/);
      if (match) throw new SandboxNotFoundError(match[1]);
    }
    throw new RemoteAPIError(404, message);
  }
  if (status === 409) {
    if (path2.includes("sandbox-pools") || path2.includes("pools")) {
      const match = path2.match(/sandbox-pools\/([^/]+)/);
      if (match) throw new PoolInUseError(match[1], message);
    }
  }
  throw new RemoteAPIError(status, message);
}
function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true
    });
  }
  return controller.signal;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var HttpClient;
var init_http = __esm({
  "src/http.ts"() {
    "use strict";
    init_defaults();
    init_errors();
    setGlobalDispatcher(
      new Agent({
        keepAliveTimeout: 6e4,
        allowH2: true
      })
    );
    HttpClient = class _HttpClient {
      baseUrl;
      headers;
      maxRetries;
      retryBackoffMs;
      timeoutMs;
      abortController = null;
      constructor(options) {
        const url = options.baseUrl;
        this.baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
        this.maxRetries = options.maxRetries ?? MAX_RETRIES;
        this.retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
        this.headers = {
          "User-Agent": `tensorlake-typescript-sdk/${SDK_VERSION}`
        };
        if (options.apiKey) {
          this.headers["Authorization"] = `Bearer ${options.apiKey}`;
        }
        if (options.organizationId) {
          this.headers["X-Forwarded-Organization-Id"] = options.organizationId;
        }
        if (options.projectId) {
          this.headers["X-Forwarded-Project-Id"] = options.projectId;
        }
        if (options.hostHeader) {
          this.headers["Host"] = options.hostHeader;
        }
        if (options.routingHint) {
          this.headers["X-Tensorlake-Route-Hint"] = options.routingHint;
        }
      }
      close() {
        this.abortController?.abort();
        this.abortController = null;
      }
      /** Make a JSON request, returning the parsed response body. */
      async requestJson(method, path2, options) {
        const response = await this.requestResponse(method, path2, {
          json: options?.body,
          headers: options?.headers,
          signal: options?.signal
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : void 0;
        return withTraceId(data, response.traceId);
      }
      /** Make a request returning raw bytes. */
      async requestBytes(method, path2, options) {
        const headers = { ...options?.headers ?? {} };
        if (options?.contentType) {
          headers["Content-Type"] = options.contentType;
        }
        const response = await this.requestResponse(method, path2, {
          body: options?.body,
          headers,
          signal: options?.signal
        });
        const buffer = await response.arrayBuffer();
        return withTraceId(new Uint8Array(buffer), response.traceId);
      }
      /** Make a request and return the response body as an SSE stream. */
      async requestStream(method, path2, options) {
        const response = await this.requestResponse(method, path2, {
          json: options?.json,
          headers: { Accept: "text/event-stream" },
          signal: options?.signal
        });
        if (!response.body) {
          throw new RemoteAPIError(
            response.status,
            "No response body for SSE stream"
          );
        }
        return withTraceId(response.body, response.traceId);
      }
      /** Make a request and return the raw Response. */
      async requestResponse(method, path2, options) {
        const headers = {
          ...this.headers,
          ...options?.headers ?? {}
        };
        const hasJsonBody = options?.json !== void 0;
        if (hasJsonBody && !hasHeader(headers, "Content-Type")) {
          headers["Content-Type"] = "application/json";
        }
        const body = hasJsonBody ? JSON.stringify(options?.json) : normalizeRequestBody(options?.body);
        const { response, traceId } = await this.doFetch(
          method,
          path2,
          body,
          headers,
          options?.signal,
          options?.allowHttpErrors ?? false
        );
        return withTraceId(response, traceId);
      }
      static makeTraceparent() {
        const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");
        const traceId = randomHex(16);
        const spanId = randomHex(8);
        return { traceparent: `00-${traceId}-${spanId}-01`, traceId };
      }
      async doFetch(method, path2, body, headers, signal, allowHttpErrors = false) {
        const url = `${this.baseUrl}${path2}`;
        const { traceparent, traceId } = _HttpClient.makeTraceparent();
        headers["traceparent"] = traceparent;
        let lastError;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
          if (attempt > 0) {
            const delay = this.retryBackoffMs * Math.pow(2, attempt - 1);
            await sleep(delay);
          }
          this.abortController = new AbortController();
          const timeoutId = setTimeout(
            () => this.abortController?.abort(),
            this.timeoutMs
          );
          const combinedSignal = signal ? anySignal([signal, this.abortController.signal]) : this.abortController.signal;
          try {
            const response = await undiciFetch(url, {
              method,
              headers,
              body,
              signal: combinedSignal
            });
            clearTimeout(timeoutId);
            if (response.ok) return { response, traceId };
            if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
              lastError = new RemoteAPIError(
                response.status,
                await response.text().catch(() => "")
              );
              continue;
            }
            if (allowHttpErrors) {
              return { response, traceId };
            }
            const errorBody = await response.text().catch(() => "");
            throwMappedError(response.status, errorBody, path2);
          } catch (err) {
            clearTimeout(timeoutId);
            if (err instanceof RemoteAPIError || err instanceof SandboxNotFoundError || err instanceof PoolNotFoundError || err instanceof PoolInUseError) {
              throw err;
            }
            if (signal?.aborted) {
              throw new SandboxConnectionError("Request aborted");
            }
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt >= this.maxRetries) {
              throw new SandboxConnectionError(lastError.message);
            }
          }
        }
        throw new SandboxConnectionError(lastError?.message ?? "Request failed");
      }
    };
  }
});

// src/models.ts
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
}
function parseTimestamp(v) {
  if (v == null) return void 0;
  if (v instanceof Date) return v;
  if (typeof v === "string") {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? void 0 : new Date(parsed);
  }
  const ts = Number(v);
  if (isNaN(ts)) return void 0;
  if (ts > 1e15) return new Date(ts / 1e3);
  if (ts > 1e12) return new Date(ts);
  return new Date(ts * 1e3);
}
function fromSnakeKeys(obj, idField) {
  if (Array.isArray(obj)) return obj.map((item) => fromSnakeKeys(item, idField));
  if (obj !== null && typeof obj === "object" && !(obj instanceof Date)) {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      let key;
      if (k === "id" && idField) {
        key = idField;
      } else {
        key = snakeToCamel(k);
      }
      if (key.endsWith("At") || key === "timestamp" || key === "startedAt" || key === "endedAt") {
        result[key] = parseTimestamp(v);
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        result[key] = fromSnakeKeys(v);
      } else if (Array.isArray(v)) {
        result[key] = v.map((item) => fromSnakeKeys(item));
      } else {
        result[key] = v === null ? void 0 : v;
      }
    }
    return result;
  }
  return obj;
}
var SandboxStatus, SnapshotStatus, ProcessStatus, StdinMode, OutputMode, ContainerState;
var init_models = __esm({
  "src/models.ts"() {
    "use strict";
    SandboxStatus = /* @__PURE__ */ ((SandboxStatus3) => {
      SandboxStatus3["PENDING"] = "pending";
      SandboxStatus3["RUNNING"] = "running";
      SandboxStatus3["SNAPSHOTTING"] = "snapshotting";
      SandboxStatus3["SUSPENDING"] = "suspending";
      SandboxStatus3["SUSPENDED"] = "suspended";
      SandboxStatus3["TERMINATED"] = "terminated";
      return SandboxStatus3;
    })(SandboxStatus || {});
    SnapshotStatus = /* @__PURE__ */ ((SnapshotStatus3) => {
      SnapshotStatus3["IN_PROGRESS"] = "in_progress";
      SnapshotStatus3["COMPLETED"] = "completed";
      SnapshotStatus3["FAILED"] = "failed";
      return SnapshotStatus3;
    })(SnapshotStatus || {});
    ProcessStatus = /* @__PURE__ */ ((ProcessStatus2) => {
      ProcessStatus2["RUNNING"] = "running";
      ProcessStatus2["EXITED"] = "exited";
      ProcessStatus2["SIGNALED"] = "signaled";
      return ProcessStatus2;
    })(ProcessStatus || {});
    StdinMode = /* @__PURE__ */ ((StdinMode2) => {
      StdinMode2["CLOSED"] = "closed";
      StdinMode2["PIPE"] = "pipe";
      return StdinMode2;
    })(StdinMode || {});
    OutputMode = /* @__PURE__ */ ((OutputMode2) => {
      OutputMode2["CAPTURE"] = "capture";
      OutputMode2["DISCARD"] = "discard";
      return OutputMode2;
    })(OutputMode || {});
    ContainerState = /* @__PURE__ */ ((ContainerState2) => {
      ContainerState2["IDLE"] = "Idle";
      ContainerState2["RUNNING"] = "Running";
      return ContainerState2;
    })(ContainerState || {});
  }
});

// src/tunnel.ts
import * as net from "net";
import WebSocket from "ws";
async function openTunnelWebSocket(options) {
  const wsUrl = buildTunnelWsUrl(options.baseUrl, options.remotePort);
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {
      headers: options.wsHeaders
    });
    let settled = false;
    const timer = setTimeout(() => {
      fail(
        new SandboxError(
          `timed out while connecting tunnel websocket after ${(timeoutMs / 1e3).toFixed(2)}s`
        )
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("open", onOpen);
      socket.removeListener("error", onError);
      socket.removeListener("close", onCloseBeforeOpen);
      socket.removeListener("unexpected-response", onUnexpectedResponse);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error) => {
      settle(() => {
        reject(error);
      });
    };
    const onOpen = () => {
      settle(() => resolve(socket));
    };
    const onError = (error) => {
      fail(new SandboxConnectionError(error.message));
    };
    const onCloseBeforeOpen = (code, reason) => {
      const closeReason = reason.length > 0 ? reason.toString("utf8") : "no reason";
      fail(
        new SandboxError(
          `tunnel websocket closed before opening: ${code} ${closeReason}`
        )
      );
    };
    const onUnexpectedResponse = (_request, response) => {
      const status = response.statusCode ?? 0;
      const statusMessage = response.statusMessage?.trim();
      fail(
        new SandboxError(
          `tunnel websocket handshake failed with HTTP ${status}${statusMessage ? ` ${statusMessage}` : ""}`
        )
      );
    };
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("close", onCloseBeforeOpen);
    socket.on("unexpected-response", onUnexpectedResponse);
  });
}
function buildTunnelWsUrl(baseUrl, remotePort) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/tunnels/tcp";
  url.search = `port=${encodeURIComponent(String(remotePort))}`;
  return url.toString();
}
function normalizeWebSocketData(message) {
  if (Buffer.isBuffer(message)) return message;
  if (Array.isArray(message)) {
    return Buffer.concat(message.map((part) => Buffer.from(part)));
  }
  return Buffer.from(message);
}
async function relaySocket(localSocket, websocket) {
  return new Promise((resolve) => {
    let settled = false;
    const keepAliveInterval = setInterval(() => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.ping();
      }
    }, WEBSOCKET_KEEPALIVE_INTERVAL_MS);
    keepAliveInterval.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(keepAliveInterval);
      cleanup();
      resolve();
    };
    const cleanup = () => {
      localSocket.removeListener("data", onLocalData);
      localSocket.removeListener("end", onLocalEnd);
      localSocket.removeListener("close", onLocalClose);
      localSocket.removeListener("error", onLocalError);
      websocket.removeListener("message", onWsMessage);
      websocket.removeListener("close", onWsClose);
      websocket.removeListener("error", onWsError);
      websocket.removeListener("ping", onWsPing);
    };
    const onLocalData = (chunk) => {
      if (websocket.readyState !== WebSocket.OPEN) {
        localSocket.destroy();
        return;
      }
      websocket.send(chunk, { binary: true }, (error) => {
        if (error) {
          localSocket.destroy(error);
        }
      });
    };
    const onLocalEnd = () => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      }
    };
    const onLocalClose = () => {
      if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
        websocket.close();
      }
      finish();
    };
    const onLocalError = () => {
      websocket.close();
      finish();
    };
    const onWsMessage = (message, isBinary) => {
      if (!isBinary) {
        localSocket.destroy(
          new SandboxError("received unexpected text frame from tunnel")
        );
        websocket.close();
        return;
      }
      const payload = normalizeWebSocketData(message);
      if (!localSocket.destroyed) {
        localSocket.write(payload);
      }
    };
    const onWsClose = () => {
      if (!localSocket.destroyed) {
        localSocket.end();
      }
      finish();
    };
    const onWsError = (error) => {
      localSocket.destroy(error);
      finish();
    };
    const onWsPing = (data) => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.pong(data, false, () => {
        });
      }
    };
    localSocket.on("data", onLocalData);
    localSocket.on("end", onLocalEnd);
    localSocket.on("close", onLocalClose);
    localSocket.on("error", onLocalError);
    websocket.on("message", onWsMessage);
    websocket.on("close", onWsClose);
    websocket.on("error", onWsError);
    websocket.on("ping", onWsPing);
  });
}
async function listenServer(server, localPort, localHost) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(
        new SandboxError(
          `failed to bind local tunnel listener on ${localHost}:${localPort}: ${error.message}`
        )
      );
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(localPort, localHost);
  });
}
function validatePort(port, label, allowZero = false) {
  if (!Number.isInteger(port)) {
    throw new SandboxError(`${label} must be an integer, got ${port}`);
  }
  if (allowZero && port === 0) {
    return port;
  }
  if (port < 1 || port > 65535) {
    throw new SandboxError(`${label} must be between 1 and 65535, got ${port}`);
  }
  return port;
}
function secondsToMillis(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new SandboxError(`timeout must be >= 0 seconds, got ${seconds}`);
  }
  return Math.round(seconds * 1e3);
}
async function withTimeout(timeoutMs, operation, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SandboxError(timeoutMessage));
    }, timeoutMs);
    void operation().then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
var DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS, WEBSOCKET_KEEPALIVE_INTERVAL_MS, TunnelByteStream, TcpTunnel;
var init_tunnel = __esm({
  "src/tunnel.ts"() {
    "use strict";
    init_errors();
    DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS = 1e4;
    WEBSOCKET_KEEPALIVE_INTERVAL_MS = 15e3;
    TunnelByteStream = class _TunnelByteStream {
      socket;
      readBuffer = Buffer.alloc(0);
      pendingReads = [];
      closeError = null;
      closePromise = null;
      keepAliveInterval;
      constructor(socket) {
        this.socket = socket;
        this.keepAliveInterval = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.ping();
          }
        }, WEBSOCKET_KEEPALIVE_INTERVAL_MS);
        this.keepAliveInterval.unref?.();
        socket.on("message", (message, isBinary) => {
          if (!isBinary) {
            this.fail(
              new SandboxError("desktop tunnel received unexpected text frame")
            );
            return;
          }
          this.pushBytes(normalizeWebSocketData(message));
        });
        socket.on("ping", (data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.pong(data, false, () => {
            });
          }
        });
        socket.on("close", (_code, reason) => {
          clearInterval(this.keepAliveInterval);
          const closeReason = reason.length > 0 ? reason.toString("utf8") : "desktop tunnel closed unexpectedly";
          this.fail(new SandboxError(closeReason));
        });
        socket.on("error", (error) => {
          clearInterval(this.keepAliveInterval);
          this.fail(new SandboxConnectionError(error.message));
        });
      }
      static async connect(options) {
        const socket = await openTunnelWebSocket(options);
        return new _TunnelByteStream(socket);
      }
      async readExactly(length) {
        if (length < 0) {
          throw new SandboxError(`read length must be >= 0, got ${length}`);
        }
        if (length === 0) {
          return Buffer.alloc(0);
        }
        if (this.readBuffer.length >= length) {
          const chunk = this.readBuffer.subarray(0, length);
          this.readBuffer = this.readBuffer.subarray(length);
          return chunk;
        }
        if (this.closeError) {
          throw this.closeError;
        }
        return new Promise((resolve, reject) => {
          this.pendingReads.push({ length, resolve, reject });
        });
      }
      async writeAll(data) {
        if (this.closeError) {
          throw this.closeError;
        }
        if (this.socket.readyState !== WebSocket.OPEN) {
          throw new SandboxError("desktop tunnel is not connected");
        }
        const payload = Buffer.from(data);
        await new Promise((resolve, reject) => {
          this.socket.send(payload, { binary: true }, (error) => {
            if (error) {
              reject(new SandboxConnectionError(error.message));
              return;
            }
            resolve();
          });
        });
      }
      async close() {
        if (this.closePromise) {
          return this.closePromise;
        }
        if (this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) {
          this.closePromise = Promise.resolve();
          return this.closePromise;
        }
        this.closePromise = new Promise((resolve) => {
          const onClose = () => {
            this.socket.removeListener("close", onClose);
            resolve();
          };
          this.socket.on("close", onClose);
          this.socket.close();
        });
        return this.closePromise;
      }
      pushBytes(chunk) {
        this.readBuffer = this.readBuffer.length === 0 ? chunk : Buffer.from(Buffer.concat([this.readBuffer, chunk]));
        this.flushPendingReads();
      }
      flushPendingReads() {
        while (this.pendingReads.length > 0) {
          const next = this.pendingReads[0];
          if (this.readBuffer.length < next.length) {
            break;
          }
          const chunk = this.readBuffer.subarray(0, next.length);
          this.readBuffer = this.readBuffer.subarray(next.length);
          this.pendingReads.shift();
          next.resolve(chunk);
        }
      }
      fail(error) {
        if (this.closeError) {
          return;
        }
        this.closeError = error;
        while (this.pendingReads.length > 0) {
          const pending = this.pendingReads.shift();
          pending?.reject(error);
        }
      }
    };
    TcpTunnel = class _TcpTunnel {
      remotePort;
      localHost;
      localPort;
      baseUrl;
      wsHeaders;
      server;
      connectTimeoutMs;
      activeRelays = /* @__PURE__ */ new Set();
      closePromise = null;
      constructor(options) {
        this.baseUrl = options.baseUrl;
        this.wsHeaders = options.wsHeaders;
        this.remotePort = options.remotePort;
        this.localHost = options.localHost;
        this.localPort = options.localPort;
        this.server = options.server;
        this.connectTimeoutMs = options.connectTimeoutMs;
      }
      static async listen(options) {
        const remotePort = validatePort(options.remotePort, "remote port");
        const localHost = options.localHost ?? "127.0.0.1";
        const localPort = validatePort(
          options.localPort ?? remotePort,
          "local port",
          true
        );
        const connectTimeoutMs = secondsToMillis(options.connectTimeout ?? 10);
        const server = net.createServer();
        await listenServer(server, localPort, localHost);
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          throw new SandboxError("failed to determine bound tunnel address");
        }
        const tunnel = new _TcpTunnel({
          baseUrl: options.baseUrl,
          wsHeaders: options.wsHeaders,
          remotePort,
          localHost,
          localPort: address.port,
          server,
          connectTimeoutMs
        });
        server.on("connection", (localSocket) => {
          void tunnel.handleConnection(localSocket);
        });
        return tunnel;
      }
      address() {
        return { host: this.localHost, port: this.localPort };
      }
      async close() {
        if (this.closePromise) {
          return this.closePromise;
        }
        for (const relay of this.activeRelays) {
          relay.localSocket.destroy();
          relay.websocket?.close();
        }
        this.closePromise = new Promise((resolve, reject) => {
          this.server.close((error) => {
            if (error) {
              reject(new SandboxError(`failed to close tunnel listener: ${error.message}`));
              return;
            }
            resolve();
          });
        });
        return this.closePromise;
      }
      async handleConnection(localSocket) {
        localSocket.setNoDelay(true);
        const relay = { localSocket, websocket: null };
        this.activeRelays.add(relay);
        try {
          relay.websocket = await openTunnelWebSocket({
            baseUrl: this.baseUrl,
            wsHeaders: this.wsHeaders,
            remotePort: this.remotePort,
            connectTimeoutMs: this.connectTimeoutMs
          });
          await relaySocket(localSocket, relay.websocket);
        } catch (error) {
          localSocket.destroy(
            error instanceof Error ? error : new Error(String(error))
          );
        } finally {
          this.activeRelays.delete(relay);
        }
      }
    };
  }
});

// src/desktop.ts
import { deflateSync } from "zlib";
async function negotiateSecurity(transport, version, password) {
  let securityTypes;
  if (version.minor === 3) {
    const securityType = await readU32(transport);
    if (securityType === 0) {
      const reasonLength = await readU32(transport);
      const reason = (await transport.readExactly(reasonLength)).toString("utf8");
      throw new SandboxError(`VNC security negotiation failed: ${reason}`);
    }
    securityTypes = [securityType];
  } else {
    const count = await readU8(transport);
    if (count === 0) {
      const reasonLength = await readU32(transport);
      const reason = (await transport.readExactly(reasonLength)).toString("utf8");
      throw new SandboxError(`VNC security negotiation failed: ${reason}`);
    }
    securityTypes = [...await transport.readExactly(count)];
  }
  let selected;
  if (password != null && securityTypes.includes(SECURITY_TYPE_VNC_AUTH)) {
    selected = SECURITY_TYPE_VNC_AUTH;
  } else if (securityTypes.includes(SECURITY_TYPE_NONE)) {
    selected = SECURITY_TYPE_NONE;
  } else if (securityTypes.includes(SECURITY_TYPE_VNC_AUTH)) {
    throw new SandboxError(
      "VNC server requires password authentication but no password was provided"
    );
  } else {
    throw new SandboxError(
      `unsupported VNC security types advertised by server: [${securityTypes.join(", ")}]`
    );
  }
  if (version.minor >= 7) {
    await transport.writeAll(Uint8Array.of(selected));
  }
  if (selected === SECURITY_TYPE_VNC_AUTH) {
    if (password == null) {
      throw new SandboxError(
        "VNC server requires password authentication but no password was provided"
      );
    }
    const challenge = await transport.readExactly(16);
    const response = encryptVncChallenge(Buffer.from(password, "utf8"), challenge);
    await transport.writeAll(response);
    await readSecurityResult(transport, version.minor >= 8);
  } else if (version.minor >= 8) {
    await readSecurityResult(transport, true);
  }
  return selected;
}
function encryptVncChallenge(password, challenge) {
  if (challenge.length !== 16) {
    throw new SandboxError("VNC authentication challenge must be 16 bytes");
  }
  const key = Buffer.alloc(8);
  for (let index = 0; index < Math.min(password.length, 8); index += 1) {
    key[index] = reverseBits(password[index]);
  }
  const roundKeys = buildDesRoundKeys(key);
  const output = Buffer.alloc(16);
  for (let blockIndex = 0; blockIndex < 2; blockIndex += 1) {
    const start = blockIndex * 8;
    const encrypted = encryptDesBlock(challenge.subarray(start, start + 8), roundKeys);
    output.set(encrypted, start);
  }
  return output;
}
function reverseBits(value) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    reversed |= (value >> bit & 1) << 7 - bit;
  }
  return reversed;
}
async function readSecurityResult(transport, hasReasonString) {
  const status = await readU32(transport);
  if (status === 0) {
    return;
  }
  let reason;
  if (hasReasonString) {
    const reasonLength = await readU32(transport);
    reason = (await transport.readExactly(reasonLength)).toString("utf8");
  } else if (status === 1) {
    reason = "authentication failed";
  } else {
    reason = `security handshake failed with status ${status}`;
  }
  throw new SandboxError(`VNC security negotiation failed: ${reason}`);
}
async function sendSetPixelFormat(transport, pixelFormat) {
  const message = Buffer.alloc(20);
  message[0] = 0;
  message.set(pixelFormat.encode(), 4);
  await transport.writeAll(message);
}
async function sendSetEncodings(transport, encodings) {
  const message = Buffer.alloc(4 + encodings.length * 4);
  message[0] = 2;
  message.writeUInt16BE(encodings.length, 2);
  for (let index = 0; index < encodings.length; index += 1) {
    message.writeInt32BE(encodings[index], 4 + index * 4);
  }
  await transport.writeAll(message);
}
async function sendFramebufferUpdateRequest(transport, incremental, x, y, width, height) {
  const message = Buffer.alloc(10);
  message[0] = 3;
  message[1] = incremental ? 1 : 0;
  message.writeUInt16BE(x, 2);
  message.writeUInt16BE(y, 4);
  message.writeUInt16BE(width, 6);
  message.writeUInt16BE(height, 8);
  await transport.writeAll(message);
}
async function sendPointerEvent(transport, buttonMask2, x, y) {
  const message = Buffer.alloc(6);
  message[0] = 5;
  message[1] = buttonMask2;
  message.writeUInt16BE(x, 2);
  message.writeUInt16BE(y, 4);
  await transport.writeAll(message);
}
async function sendKeyEvent(transport, down, keysym) {
  const message = Buffer.alloc(8);
  message[0] = 4;
  message[1] = down ? 1 : 0;
  message.writeUInt32BE(keysym, 4);
  await transport.writeAll(message);
}
async function readU8(transport) {
  return (await transport.readExactly(1))[0];
}
async function readU16(transport) {
  return (await transport.readExactly(2)).readUInt16BE(0);
}
async function readU32(transport) {
  return (await transport.readExactly(4)).readUInt32BE(0);
}
async function readI32(transport) {
  return (await transport.readExactly(4)).readInt32BE(0);
}
function scaleChannel(value, max) {
  if (max === 0) {
    throw new SandboxError("invalid VNC pixel format with zero channel range");
  }
  return Math.trunc(value * 255 / max);
}
function allocateFramebuffer(width, height) {
  return new Uint8Array(width * height * 4);
}
function normalizeDesktopConnectRequest(options) {
  return {
    ...options,
    port: validatePort2(options.port ?? 5901, "desktop port"),
    shared: options.shared ?? true,
    connectTimeout: options.connectTimeout ?? 10
  };
}
async function openDesktopSession(options) {
  const connectTimeoutMs = secondsToMillis2(options.connectTimeout);
  const state = {};
  try {
    return await withTimeout(
      connectTimeoutMs,
      async () => {
        state.transport = await TunnelByteStream.connect({
          baseUrl: options.baseUrl,
          wsHeaders: options.wsHeaders,
          remotePort: options.port,
          connectTimeoutMs
        });
        return DesktopSession.connect(
          state.transport,
          options.password,
          options.shared
        );
      },
      `timed out while connecting desktop session after ${options.connectTimeout.toFixed(2)}s`
    );
  } catch (error) {
    if (state.transport) {
      await state.transport.close().catch(() => {
      });
    }
    throw error;
  }
}
function isReconnectableDesktopScreenshotError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("desktop tunnel closed unexpectedly") || message.includes("desktop tunnel is not connected") || message.includes("connection closed") || message.includes("econnreset") || message.includes("timed out waiting for initial desktop framebuffer") || message.includes("timed out while connecting tunnel websocket") || message.includes("tunnel websocket closed before opening") || message.includes("tunnel websocket handshake failed");
}
function createDeferredSignal() {
  let resolveCurrent;
  let promise = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  return {
    resolve() {
      resolveCurrent();
      promise = new Promise((resolve) => {
        resolveCurrent = resolve;
      });
    },
    wait() {
      return promise;
    }
  };
}
function normalizeError(error) {
  return error instanceof Error ? error : new SandboxError(String(error));
}
function buttonMask(button) {
  const normalized = button.trim().toLowerCase();
  if (normalized === "left") return BUTTON_LEFT_MASK;
  if (normalized === "middle") return BUTTON_MIDDLE_MASK;
  if (normalized === "right") return BUTTON_RIGHT_MASK;
  throw new SandboxError(
    `unsupported mouse button \`${button}\`; expected left, middle, or right`
  );
}
function keysymFromKeyName(key) {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    throw new SandboxError("desktop key name cannot be empty");
  }
  if ([...trimmed].length === 1) {
    return keysymFromChar(trimmed);
  }
  const normalized = trimmed.toLowerCase();
  const special = SPECIAL_KEYSYMS.get(normalized);
  if (special != null) {
    return special;
  }
  const functionMatch = /^f([1-9]|1[0-2])$/.exec(normalized);
  if (functionMatch) {
    return 65469 + Number.parseInt(functionMatch[1], 10);
  }
  throw new SandboxError(`unsupported desktop key \`${trimmed}\``);
}
function keysymFromChar(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint == null) {
    throw new SandboxError("desktop key name cannot be empty");
  }
  if (char === "\n" || char === "\r") return 65293;
  if (char === "	") return 65289;
  if (char === "\b") return 65288;
  if (codePoint >= 32 && codePoint <= 126) return codePoint;
  if (codePoint < 32 || codePoint >= 127 && codePoint <= 159) {
    throw new SandboxError(
      `unsupported control character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} for desktop typing`
    );
  }
  return 16777216 | codePoint;
}
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const srcOffset = row * stride;
    const dstOffset = row * (stride + 1);
    raw[dstOffset] = 0;
    raw.set(rgba.subarray(srcOffset, srcOffset + stride), dstOffset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
function pngChunk(type, data) {
  const chunkType = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([chunkType, data])), 0);
  return Buffer.concat([length, chunkType, data, crc]);
}
function crc32(data) {
  let crc = 4294967295;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
function validateCoordinate(value, label) {
  return validateIntegerInRange(value, label, 0, 65535);
}
function validatePort2(value, label) {
  return validateIntegerInRange(value, label, 1, 65535);
}
function validateIntegerInRange(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SandboxError(`${label} must be an integer between ${min} and ${max}, got ${value}`);
  }
  return value;
}
function validateInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new SandboxError(`${label} must be an integer, got ${value}`);
  }
  return value;
}
function validateNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SandboxError(`${label} must be a non-negative integer, got ${value}`);
  }
  return value;
}
function secondsToMillis2(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new SandboxError(`timeout must be >= 0 seconds, got ${seconds}`);
  }
  return Math.round(seconds * 1e3);
}
function buildDesRoundKeys(key) {
  const keyBlock = bytesToBigInt(key);
  const permuted = permuteBits(keyBlock, DES_PC1, 64);
  let c = Number(permuted >> 28n & 0x0fffffffn);
  let d = Number(permuted & 0x0fffffffn);
  const roundKeys = [];
  for (const rotation of DES_ROTATIONS) {
    c = rotateLeft28(c, rotation);
    d = rotateLeft28(d, rotation);
    const combined = BigInt(c) << 28n | BigInt(d);
    roundKeys.push(permuteBits(combined, DES_PC2, 56));
  }
  return roundKeys;
}
function encryptDesBlock(block, roundKeys) {
  let value = permuteBits(bytesToBigInt(block), DES_INITIAL_PERMUTATION, 64);
  let left = Number(value >> 32n & 0xffffffffn);
  let right = Number(value & 0xffffffffn);
  for (const roundKey of roundKeys) {
    const nextLeft = right;
    const nextRight = (left ^ feistel(right, roundKey)) >>> 0;
    left = nextLeft >>> 0;
    right = nextRight;
  }
  value = BigInt(right) << 32n | BigInt(left);
  return bigIntToBytes(permuteBits(value, DES_FINAL_PERMUTATION, 64), 8);
}
function feistel(right, roundKey) {
  const expanded = permuteBits(BigInt(right >>> 0), DES_EXPANSION, 32) ^ roundKey;
  let output = 0;
  for (let index = 0; index < 8; index += 1) {
    const shift = BigInt((7 - index) * 6);
    const chunk = Number(expanded >> shift & 0x3fn);
    const row = (chunk & 32) >> 4 | chunk & 1;
    const column = chunk >> 1 & 15;
    output = output << 4 | DES_SBOXES[index][row * 16 + column];
  }
  return Number(permuteBits(BigInt(output >>> 0), DES_P_PERMUTATION, 32)) >>> 0;
}
function rotateLeft28(value, shift) {
  const masked = value & 268435455;
  return (masked << shift | masked >>> 28 - shift) & 268435455;
}
function permuteBits(input, table, inputBits) {
  let output = 0n;
  for (const position of table) {
    const shift = BigInt(inputBits - position);
    output = output << 1n | input >> shift & 1n;
  }
  return output;
}
function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) {
    value = value << 8n | BigInt(byte);
  }
  return value;
}
function bigIntToBytes(value, length) {
  const out = Buffer.alloc(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}
var SECURITY_TYPE_NONE, SECURITY_TYPE_VNC_AUTH, ENCODING_RAW, ENCODING_DESKTOP_SIZE, BUTTON_LEFT_MASK, BUTTON_MIDDLE_MASK, BUTTON_RIGHT_MASK, BUTTON_SCROLL_UP_MASK, BUTTON_SCROLL_DOWN_MASK, PNG_SIGNATURE, CRC32_TABLE, DesktopSession, Desktop, ProtocolVersion, PixelFormat, ServerInit, SPECIAL_KEYSYMS, DES_INITIAL_PERMUTATION, DES_FINAL_PERMUTATION, DES_EXPANSION, DES_P_PERMUTATION, DES_PC1, DES_PC2, DES_ROTATIONS, DES_SBOXES;
var init_desktop = __esm({
  "src/desktop.ts"() {
    "use strict";
    init_errors();
    init_tunnel();
    SECURITY_TYPE_NONE = 1;
    SECURITY_TYPE_VNC_AUTH = 2;
    ENCODING_RAW = 0;
    ENCODING_DESKTOP_SIZE = -223;
    BUTTON_LEFT_MASK = 1;
    BUTTON_MIDDLE_MASK = 1 << 1;
    BUTTON_RIGHT_MASK = 1 << 2;
    BUTTON_SCROLL_UP_MASK = 1 << 3;
    BUTTON_SCROLL_DOWN_MASK = 1 << 4;
    PNG_SIGNATURE = Buffer.from([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10
    ]);
    CRC32_TABLE = buildCrc32Table();
    DesktopSession = class _DesktopSession {
      transport;
      width;
      height;
      pixelFormat;
      framebuffer;
      pointerX = 0;
      pointerY = 0;
      buttonMask = 0;
      framebufferVersion = 0;
      closed = false;
      updateLoopError = null;
      updateSignal = createDeferredSignal();
      updateLoopPromise = null;
      constructor(options) {
        this.transport = options.transport;
        this.width = options.width;
        this.height = options.height;
        this.pixelFormat = options.pixelFormat;
        this.framebuffer = options.framebuffer;
      }
      static async connect(transport, password, shared = true) {
        const serverVersion = await ProtocolVersion.read(transport);
        const clientVersion = serverVersion.negotiated();
        await transport.writeAll(Buffer.from(clientVersion.render(), "ascii"));
        await negotiateSecurity(transport, clientVersion, password);
        await transport.writeAll(Uint8Array.of(shared ? 1 : 0));
        const init = await ServerInit.read(transport);
        if (!init.pixelFormat.trueColor) {
          throw new SandboxError(
            "desktop sessions require a true-color VNC pixel format"
          );
        }
        const pixelFormat = PixelFormat.preferred();
        await sendSetPixelFormat(transport, pixelFormat);
        await sendSetEncodings(transport, [ENCODING_RAW, ENCODING_DESKTOP_SIZE]);
        const session = new _DesktopSession({
          transport,
          width: init.width,
          height: init.height,
          pixelFormat,
          framebuffer: allocateFramebuffer(init.width, init.height)
        });
        session.startFramebufferUpdates();
        return session;
      }
      async close() {
        this.closed = true;
        this.updateSignal.resolve();
        await this.transport.close();
        await this.updateLoopPromise;
      }
      async screenshot(timeoutSeconds = 5) {
        await this.waitForFramebufferVersion(
          1,
          timeoutSeconds,
          `timed out waiting for initial desktop framebuffer after ${timeoutSeconds.toFixed(2)}s`
        );
        return encodePng(this.width, this.height, this.framebuffer);
      }
      getFrameVersion() {
        return this.framebufferVersion;
      }
      async screenshotAfter(frameVersion, timeoutSeconds = 1) {
        const minimumVersion = validateNonNegativeInteger(frameVersion, "frame version") + 1;
        if (this.framebufferVersion < minimumVersion) {
          await this.waitForFramebufferVersion(
            minimumVersion,
            timeoutSeconds,
            `timed out waiting for a fresher desktop framebuffer after ${timeoutSeconds.toFixed(2)}s`
          );
        }
        return encodePng(this.width, this.height, this.framebuffer);
      }
      async moveMouse(x, y) {
        const nextX = validateCoordinate(x, "mouse x coordinate");
        const nextY = validateCoordinate(y, "mouse y coordinate");
        this.ensurePointerInBounds(nextX, nextY);
        this.pointerX = nextX;
        this.pointerY = nextY;
        await sendPointerEvent(this.transport, this.buttonMask, nextX, nextY);
      }
      async mousePress(options) {
        const button = options?.button ?? "left";
        await this.moveIfRequested(options?.x, options?.y);
        this.buttonMask |= buttonMask(button);
        await sendPointerEvent(
          this.transport,
          this.buttonMask,
          this.pointerX,
          this.pointerY
        );
      }
      async mouseRelease(options) {
        const button = options?.button ?? "left";
        await this.moveIfRequested(options?.x, options?.y);
        this.buttonMask &= ~buttonMask(button);
        await sendPointerEvent(
          this.transport,
          this.buttonMask,
          this.pointerX,
          this.pointerY
        );
      }
      async click(options) {
        await this.mousePress(options);
        await this.mouseRelease({ button: options?.button ?? "left" });
      }
      async doubleClick(options) {
        const button = options?.button ?? "left";
        const delayMs = options?.delayMs ?? 50;
        validateNonNegativeInteger(delayMs, "double click delay");
        await this.click({ button, x: options?.x, y: options?.y });
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        await this.click({ button });
      }
      async scroll(steps, x, y) {
        const normalizedSteps = validateInteger(steps, "scroll steps");
        await this.moveIfRequested(x, y);
        if (normalizedSteps === 0) {
          return;
        }
        const wheelMask = normalizedSteps > 0 ? BUTTON_SCROLL_UP_MASK : BUTTON_SCROLL_DOWN_MASK;
        const stepCount = Math.abs(normalizedSteps);
        for (let index = 0; index < stepCount; index += 1) {
          await sendPointerEvent(
            this.transport,
            this.buttonMask | wheelMask,
            this.pointerX,
            this.pointerY
          );
          await sendPointerEvent(
            this.transport,
            this.buttonMask,
            this.pointerX,
            this.pointerY
          );
        }
      }
      async keyDown(key) {
        await sendKeyEvent(this.transport, true, keysymFromKeyName(key));
      }
      async keyUp(key) {
        await sendKeyEvent(this.transport, false, keysymFromKeyName(key));
      }
      async press(keys) {
        const parts = Array.isArray(keys) ? keys : [keys];
        if (parts.length === 0) {
          throw new SandboxError("desktop press requires at least one key");
        }
        const keysyms = parts.map((part) => keysymFromKeyName(part));
        if (keysyms.length === 1) {
          await sendKeyEvent(this.transport, true, keysyms[0]);
          await sendKeyEvent(this.transport, false, keysyms[0]);
          return;
        }
        for (const keysym of keysyms.slice(0, -1)) {
          await sendKeyEvent(this.transport, true, keysym);
        }
        const last = keysyms[keysyms.length - 1];
        await sendKeyEvent(this.transport, true, last);
        await sendKeyEvent(this.transport, false, last);
        for (const keysym of keysyms.slice(0, -1).reverse()) {
          await sendKeyEvent(this.transport, false, keysym);
        }
      }
      async typeText(text) {
        for (const char of text) {
          const keysym = keysymFromChar(char);
          await sendKeyEvent(this.transport, true, keysym);
          await sendKeyEvent(this.transport, false, keysym);
        }
      }
      async moveIfRequested(x, y) {
        if (x == null && y == null) {
          return;
        }
        if (x == null || y == null) {
          throw new SandboxError(
            "desktop pointer actions require both x and y when specifying coordinates"
          );
        }
        await this.moveMouse(x, y);
      }
      ensurePointerInBounds(x, y) {
        if (this.width > 0 && x >= this.width) {
          throw new SandboxError(
            `mouse x coordinate ${x} is outside desktop width ${this.width}`
          );
        }
        if (this.height > 0 && y >= this.height) {
          throw new SandboxError(
            `mouse y coordinate ${y} is outside desktop height ${this.height}`
          );
        }
      }
      startFramebufferUpdates() {
        if (this.updateLoopPromise) {
          return;
        }
        this.updateLoopPromise = this.runFramebufferUpdateLoop().catch((error) => {
          if (this.closed) {
            return;
          }
          this.updateLoopError = normalizeError(error);
          this.updateSignal.resolve();
        });
      }
      async runFramebufferUpdateLoop() {
        let incremental = false;
        while (!this.closed) {
          await sendFramebufferUpdateRequest(
            this.transport,
            incremental,
            0,
            0,
            this.width,
            this.height
          );
          const outcome = await this.readUntilFramebufferUpdate();
          if (outcome.sawResize && !outcome.sawRaw) {
            incremental = false;
            continue;
          }
          if (outcome.sawRaw) {
            this.framebufferVersion += 1;
            this.updateSignal.resolve();
          }
          incremental = true;
        }
      }
      async readUntilFramebufferUpdate() {
        while (true) {
          const outcome = await this.readServerMessage();
          if (outcome.kind === "framebufferUpdate") {
            return outcome;
          }
        }
      }
      async waitForFramebufferVersion(minimumVersion, timeoutSeconds, timeoutMessage) {
        const timeoutMs = secondsToMillis2(timeoutSeconds);
        const deadline = Date.now() + timeoutMs;
        while (this.framebufferVersion < minimumVersion) {
          if (this.updateLoopError) {
            throw this.updateLoopError;
          }
          if (this.closed) {
            throw new SandboxError("desktop session is closed");
          }
          const observedVersion = this.framebufferVersion;
          const waitForUpdate = this.updateSignal.wait();
          if (this.framebufferVersion !== observedVersion) {
            continue;
          }
          const remainingMs = Math.max(0, deadline - Date.now());
          if (remainingMs === 0) {
            break;
          }
          await withTimeout(remainingMs, () => waitForUpdate, timeoutMessage);
        }
        if (this.framebufferVersion < minimumVersion) {
          throw new SandboxError(timeoutMessage);
        }
      }
      async readServerMessage() {
        const messageType = await readU8(this.transport);
        if (messageType === 0) {
          return this.readFramebufferUpdate();
        }
        if (messageType === 1) {
          await this.readSetColorMapEntries();
          return { kind: "bell" };
        }
        if (messageType === 2) {
          return { kind: "bell" };
        }
        if (messageType === 3) {
          await this.readServerCutText();
          return { kind: "serverCutText" };
        }
        throw new SandboxError(`unsupported VNC server message type ${messageType}`);
      }
      async readFramebufferUpdate() {
        await readU8(this.transport);
        const rectangleCount = await readU16(this.transport);
        let sawResize = false;
        let sawRaw = false;
        for (let index = 0; index < rectangleCount; index += 1) {
          const x = await readU16(this.transport);
          const y = await readU16(this.transport);
          const width = await readU16(this.transport);
          const height = await readU16(this.transport);
          const encoding = await readI32(this.transport);
          if (encoding === ENCODING_RAW) {
            const bytesPerPixel = this.pixelFormat.bytesPerPixel();
            const length = width * height * bytesPerPixel;
            const data = await this.transport.readExactly(length);
            this.blitRawRectangle(x, y, width, height, data);
            sawRaw = true;
            continue;
          }
          if (encoding === ENCODING_DESKTOP_SIZE) {
            this.resizeFramebuffer(width, height);
            sawResize = true;
            continue;
          }
          throw new SandboxError(`unsupported VNC rectangle encoding ${encoding}`);
        }
        return { kind: "framebufferUpdate", sawResize, sawRaw };
      }
      async readSetColorMapEntries() {
        await readU8(this.transport);
        await readU16(this.transport);
        const colorCount = await readU16(this.transport);
        await this.transport.readExactly(colorCount * 6);
        throw new SandboxError(
          "desktop sessions do not support color-map VNC pixel formats"
        );
      }
      async readServerCutText() {
        await this.transport.readExactly(3);
        const length = await readU32(this.transport);
        await this.transport.readExactly(length);
      }
      resizeFramebuffer(width, height) {
        this.width = width;
        this.height = height;
        this.framebuffer = allocateFramebuffer(width, height);
        this.pointerX = width > 0 ? Math.min(this.pointerX, width - 1) : 0;
        this.pointerY = height > 0 ? Math.min(this.pointerY, height - 1) : 0;
      }
      blitRawRectangle(x, y, width, height, data) {
        if (x + width > this.width || y + height > this.height) {
          throw new SandboxError("desktop raw rectangle exceeds framebuffer bounds");
        }
        const bytesPerPixel = this.pixelFormat.bytesPerPixel();
        for (let row = 0; row < height; row += 1) {
          for (let col = 0; col < width; col += 1) {
            const srcIndex = (row * width + col) * bytesPerPixel;
            const rgba = this.pixelFormat.decodePixel(
              data.subarray(srcIndex, srcIndex + bytesPerPixel)
            );
            const dstIndex = ((y + row) * this.width + x + col) * 4;
            this.framebuffer.set(rgba, dstIndex);
          }
        }
      }
    };
    Desktop = class _Desktop {
      session;
      connectRequest;
      operationChain = Promise.resolve();
      reconnectPromise = null;
      closed = false;
      constructor(session, connectRequest) {
        this.session = session;
        this.connectRequest = connectRequest;
      }
      static async connect(options) {
        const connectRequest = normalizeDesktopConnectRequest(options);
        const session = await openDesktopSession(connectRequest);
        return new _Desktop(session, connectRequest);
      }
      get width() {
        return this.session.width;
      }
      get height() {
        return this.session.height;
      }
      async close() {
        this.closed = true;
        await this.enqueue(() => this.session.close());
      }
      async screenshot(timeout = 5) {
        return this.enqueue(() => this.captureScreenshot(timeout));
      }
      getFrameVersion() {
        return this.session.getFrameVersion();
      }
      async screenshotAfter(frameVersion, timeout = 1) {
        return this.enqueue(() => this.captureScreenshotAfter(frameVersion, timeout));
      }
      async moveMouse(x, y) {
        await this.enqueue(() => this.session.moveMouse(x, y));
      }
      async mousePress(options) {
        await this.enqueue(() => this.session.mousePress(options));
      }
      async mouseRelease(options) {
        await this.enqueue(() => this.session.mouseRelease(options));
      }
      async click(options) {
        await this.enqueue(() => this.session.click(options));
      }
      async doubleClick(options) {
        await this.enqueue(() => this.session.doubleClick(options));
      }
      async leftClick(x, y) {
        await this.click({ button: "left", x, y });
      }
      async middleClick(x, y) {
        await this.click({ button: "middle", x, y });
      }
      async rightClick(x, y) {
        await this.click({ button: "right", x, y });
      }
      async scroll(steps, x, y) {
        await this.enqueue(() => this.session.scroll(steps, x, y));
      }
      async scrollUp(steps = 1, x, y) {
        await this.scroll(Math.abs(steps), x, y);
      }
      async scrollDown(steps = 1, x, y) {
        await this.scroll(-Math.abs(steps), x, y);
      }
      async keyDown(key) {
        await this.enqueue(() => this.session.keyDown(key));
      }
      async keyUp(key) {
        await this.enqueue(() => this.session.keyUp(key));
      }
      async press(keys) {
        await this.enqueue(() => this.session.press(keys));
      }
      async typeText(text) {
        await this.enqueue(() => this.session.typeText(text));
      }
      enqueue(operation) {
        const run = this.operationChain.catch(() => {
        }).then(operation);
        this.operationChain = run.then(
          () => void 0,
          () => void 0
        );
        return run;
      }
      async captureScreenshot(timeout) {
        try {
          return await this.session.screenshot(timeout);
        } catch (error) {
          if (!isReconnectableDesktopScreenshotError(error) || this.closed) {
            throw error;
          }
          await this.reconnect();
          return this.session.screenshot(timeout);
        }
      }
      async captureScreenshotAfter(frameVersion, timeout) {
        try {
          return await this.session.screenshotAfter(frameVersion, timeout);
        } catch (error) {
          if (!isReconnectableDesktopScreenshotError(error) || this.closed) {
            throw error;
          }
          await this.reconnect();
          return this.session.screenshot(timeout);
        }
      }
      async reconnect() {
        if (this.reconnectPromise) {
          return this.reconnectPromise;
        }
        this.reconnectPromise = this.performReconnect().finally(() => {
          this.reconnectPromise = null;
        });
        return this.reconnectPromise;
      }
      async performReconnect() {
        const previousSession = this.session;
        await previousSession.close().catch(() => {
        });
        this.session = await openDesktopSession(this.connectRequest);
      }
    };
    ProtocolVersion = class _ProtocolVersion {
      major;
      minor;
      constructor(major, minor) {
        this.major = major;
        this.minor = minor;
      }
      static async read(transport) {
        const raw = await transport.readExactly(12);
        const text = raw.toString("ascii");
        const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
        const match = /^RFB (\d{3})\.(\d{3})$/.exec(trimmed);
        if (!match) {
          throw new SandboxError(`invalid VNC protocol banner \`${text}\``);
        }
        return new _ProtocolVersion(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
      }
      negotiated() {
        if (this.major !== 3 || this.minor >= 8) {
          return new _ProtocolVersion(3, 8);
        }
        if (this.minor >= 7) {
          return new _ProtocolVersion(3, 7);
        }
        return new _ProtocolVersion(3, 3);
      }
      render() {
        return `RFB ${String(this.major).padStart(3, "0")}.${String(this.minor).padStart(3, "0")}
`;
      }
    };
    PixelFormat = class _PixelFormat {
      bitsPerPixel;
      depth;
      bigEndian;
      trueColor;
      redMax;
      greenMax;
      blueMax;
      redShift;
      greenShift;
      blueShift;
      constructor(options) {
        this.bitsPerPixel = options.bitsPerPixel;
        this.depth = options.depth;
        this.bigEndian = options.bigEndian;
        this.trueColor = options.trueColor;
        this.redMax = options.redMax;
        this.greenMax = options.greenMax;
        this.blueMax = options.blueMax;
        this.redShift = options.redShift;
        this.greenShift = options.greenShift;
        this.blueShift = options.blueShift;
      }
      static preferred() {
        return new _PixelFormat({
          bitsPerPixel: 32,
          depth: 24,
          bigEndian: false,
          trueColor: true,
          redMax: 255,
          greenMax: 255,
          blueMax: 255,
          redShift: 16,
          greenShift: 8,
          blueShift: 0
        });
      }
      static parse(bytes) {
        if (bytes.length !== 16) {
          throw new SandboxError("invalid VNC pixel format payload length");
        }
        return new _PixelFormat({
          bitsPerPixel: bytes[0],
          depth: bytes[1],
          bigEndian: bytes[2] !== 0,
          trueColor: bytes[3] !== 0,
          redMax: Buffer.from(bytes.subarray(4, 6)).readUInt16BE(0),
          greenMax: Buffer.from(bytes.subarray(6, 8)).readUInt16BE(0),
          blueMax: Buffer.from(bytes.subarray(8, 10)).readUInt16BE(0),
          redShift: bytes[10],
          greenShift: bytes[11],
          blueShift: bytes[12]
        });
      }
      bytesPerPixel() {
        return this.bitsPerPixel / 8;
      }
      encode() {
        const bytes = Buffer.alloc(16);
        bytes[0] = this.bitsPerPixel;
        bytes[1] = this.depth;
        bytes[2] = this.bigEndian ? 1 : 0;
        bytes[3] = this.trueColor ? 1 : 0;
        bytes.writeUInt16BE(this.redMax, 4);
        bytes.writeUInt16BE(this.greenMax, 6);
        bytes.writeUInt16BE(this.blueMax, 8);
        bytes[10] = this.redShift;
        bytes[11] = this.greenShift;
        bytes[12] = this.blueShift;
        return bytes;
      }
      decodePixel(bytes) {
        if (bytes.length !== this.bytesPerPixel()) {
          throw new SandboxError("desktop pixel buffer has an unexpected size");
        }
        let value = 0;
        if (this.bigEndian) {
          for (const byte of bytes) {
            value = value << 8 | byte;
          }
        } else {
          for (let index = 0; index < bytes.length; index += 1) {
            value |= bytes[index] << index * 8;
          }
        }
        const red = scaleChannel(value >> this.redShift & this.redMax, this.redMax);
        const green = scaleChannel(
          value >> this.greenShift & this.greenMax,
          this.greenMax
        );
        const blue = scaleChannel(value >> this.blueShift & this.blueMax, this.blueMax);
        return Uint8Array.of(red, green, blue, 255);
      }
    };
    ServerInit = class _ServerInit {
      width;
      height;
      pixelFormat;
      constructor(width, height, pixelFormat) {
        this.width = width;
        this.height = height;
        this.pixelFormat = pixelFormat;
      }
      static async read(transport) {
        const width = await readU16(transport);
        const height = await readU16(transport);
        const pixelFormat = PixelFormat.parse(await transport.readExactly(16));
        const nameLength = await readU32(transport);
        await transport.readExactly(nameLength);
        return new _ServerInit(width, height, pixelFormat);
      }
    };
    SPECIAL_KEYSYMS = /* @__PURE__ */ new Map([
      ["enter", 65293],
      ["tab", 65289],
      ["escape", 65307],
      ["backspace", 65288],
      ["delete", 65535],
      ["space", 32],
      ["up", 65362],
      ["down", 65364],
      ["left", 65361],
      ["right", 65363],
      ["home", 65360],
      ["end", 65367],
      ["pageup", 65365],
      ["pagedown", 65366],
      ["page_up", 65365],
      ["page_down", 65366],
      ["shift", 65505],
      ["ctrl", 65507],
      ["control", 65507],
      ["alt", 65513],
      ["meta", 65511]
    ]);
    DES_INITIAL_PERMUTATION = [
      58,
      50,
      42,
      34,
      26,
      18,
      10,
      2,
      60,
      52,
      44,
      36,
      28,
      20,
      12,
      4,
      62,
      54,
      46,
      38,
      30,
      22,
      14,
      6,
      64,
      56,
      48,
      40,
      32,
      24,
      16,
      8,
      57,
      49,
      41,
      33,
      25,
      17,
      9,
      1,
      59,
      51,
      43,
      35,
      27,
      19,
      11,
      3,
      61,
      53,
      45,
      37,
      29,
      21,
      13,
      5,
      63,
      55,
      47,
      39,
      31,
      23,
      15,
      7
    ];
    DES_FINAL_PERMUTATION = [
      40,
      8,
      48,
      16,
      56,
      24,
      64,
      32,
      39,
      7,
      47,
      15,
      55,
      23,
      63,
      31,
      38,
      6,
      46,
      14,
      54,
      22,
      62,
      30,
      37,
      5,
      45,
      13,
      53,
      21,
      61,
      29,
      36,
      4,
      44,
      12,
      52,
      20,
      60,
      28,
      35,
      3,
      43,
      11,
      51,
      19,
      59,
      27,
      34,
      2,
      42,
      10,
      50,
      18,
      58,
      26,
      33,
      1,
      41,
      9,
      49,
      17,
      57,
      25
    ];
    DES_EXPANSION = [
      32,
      1,
      2,
      3,
      4,
      5,
      4,
      5,
      6,
      7,
      8,
      9,
      8,
      9,
      10,
      11,
      12,
      13,
      12,
      13,
      14,
      15,
      16,
      17,
      16,
      17,
      18,
      19,
      20,
      21,
      20,
      21,
      22,
      23,
      24,
      25,
      24,
      25,
      26,
      27,
      28,
      29,
      28,
      29,
      30,
      31,
      32,
      1
    ];
    DES_P_PERMUTATION = [
      16,
      7,
      20,
      21,
      29,
      12,
      28,
      17,
      1,
      15,
      23,
      26,
      5,
      18,
      31,
      10,
      2,
      8,
      24,
      14,
      32,
      27,
      3,
      9,
      19,
      13,
      30,
      6,
      22,
      11,
      4,
      25
    ];
    DES_PC1 = [
      57,
      49,
      41,
      33,
      25,
      17,
      9,
      1,
      58,
      50,
      42,
      34,
      26,
      18,
      10,
      2,
      59,
      51,
      43,
      35,
      27,
      19,
      11,
      3,
      60,
      52,
      44,
      36,
      63,
      55,
      47,
      39,
      31,
      23,
      15,
      7,
      62,
      54,
      46,
      38,
      30,
      22,
      14,
      6,
      61,
      53,
      45,
      37,
      29,
      21,
      13,
      5,
      28,
      20,
      12,
      4
    ];
    DES_PC2 = [
      14,
      17,
      11,
      24,
      1,
      5,
      3,
      28,
      15,
      6,
      21,
      10,
      23,
      19,
      12,
      4,
      26,
      8,
      16,
      7,
      27,
      20,
      13,
      2,
      41,
      52,
      31,
      37,
      47,
      55,
      30,
      40,
      51,
      45,
      33,
      48,
      44,
      49,
      39,
      56,
      34,
      53,
      46,
      42,
      50,
      36,
      29,
      32
    ];
    DES_ROTATIONS = [
      1,
      1,
      2,
      2,
      2,
      2,
      2,
      2,
      1,
      2,
      2,
      2,
      2,
      2,
      2,
      1
    ];
    DES_SBOXES = [
      [
        14,
        4,
        13,
        1,
        2,
        15,
        11,
        8,
        3,
        10,
        6,
        12,
        5,
        9,
        0,
        7,
        0,
        15,
        7,
        4,
        14,
        2,
        13,
        1,
        10,
        6,
        12,
        11,
        9,
        5,
        3,
        8,
        4,
        1,
        14,
        8,
        13,
        6,
        2,
        11,
        15,
        12,
        9,
        7,
        3,
        10,
        5,
        0,
        15,
        12,
        8,
        2,
        4,
        9,
        1,
        7,
        5,
        11,
        3,
        14,
        10,
        0,
        6,
        13
      ],
      [
        15,
        1,
        8,
        14,
        6,
        11,
        3,
        4,
        9,
        7,
        2,
        13,
        12,
        0,
        5,
        10,
        3,
        13,
        4,
        7,
        15,
        2,
        8,
        14,
        12,
        0,
        1,
        10,
        6,
        9,
        11,
        5,
        0,
        14,
        7,
        11,
        10,
        4,
        13,
        1,
        5,
        8,
        12,
        6,
        9,
        3,
        2,
        15,
        13,
        8,
        10,
        1,
        3,
        15,
        4,
        2,
        11,
        6,
        7,
        12,
        0,
        5,
        14,
        9
      ],
      [
        10,
        0,
        9,
        14,
        6,
        3,
        15,
        5,
        1,
        13,
        12,
        7,
        11,
        4,
        2,
        8,
        13,
        7,
        0,
        9,
        3,
        4,
        6,
        10,
        2,
        8,
        5,
        14,
        12,
        11,
        15,
        1,
        13,
        6,
        4,
        9,
        8,
        15,
        3,
        0,
        11,
        1,
        2,
        12,
        5,
        10,
        14,
        7,
        1,
        10,
        13,
        0,
        6,
        9,
        8,
        7,
        4,
        15,
        14,
        3,
        11,
        5,
        2,
        12
      ],
      [
        7,
        13,
        14,
        3,
        0,
        6,
        9,
        10,
        1,
        2,
        8,
        5,
        11,
        12,
        4,
        15,
        13,
        8,
        11,
        5,
        6,
        15,
        0,
        3,
        4,
        7,
        2,
        12,
        1,
        10,
        14,
        9,
        10,
        6,
        9,
        0,
        12,
        11,
        7,
        13,
        15,
        1,
        3,
        14,
        5,
        2,
        8,
        4,
        3,
        15,
        0,
        6,
        10,
        1,
        13,
        8,
        9,
        4,
        5,
        11,
        12,
        7,
        2,
        14
      ],
      [
        2,
        12,
        4,
        1,
        7,
        10,
        11,
        6,
        8,
        5,
        3,
        15,
        13,
        0,
        14,
        9,
        14,
        11,
        2,
        12,
        4,
        7,
        13,
        1,
        5,
        0,
        15,
        10,
        3,
        9,
        8,
        6,
        4,
        2,
        1,
        11,
        10,
        13,
        7,
        8,
        15,
        9,
        12,
        5,
        6,
        3,
        0,
        14,
        11,
        8,
        12,
        7,
        1,
        14,
        2,
        13,
        6,
        15,
        0,
        9,
        10,
        4,
        5,
        3
      ],
      [
        12,
        1,
        10,
        15,
        9,
        2,
        6,
        8,
        0,
        13,
        3,
        4,
        14,
        7,
        5,
        11,
        10,
        15,
        4,
        2,
        7,
        12,
        9,
        5,
        6,
        1,
        13,
        14,
        0,
        11,
        3,
        8,
        9,
        14,
        15,
        5,
        2,
        8,
        12,
        3,
        7,
        0,
        4,
        10,
        1,
        13,
        11,
        6,
        4,
        3,
        2,
        12,
        9,
        5,
        15,
        10,
        11,
        14,
        1,
        7,
        6,
        0,
        8,
        13
      ],
      [
        4,
        11,
        2,
        14,
        15,
        0,
        8,
        13,
        3,
        12,
        9,
        7,
        5,
        10,
        6,
        1,
        13,
        0,
        11,
        7,
        4,
        9,
        1,
        10,
        14,
        3,
        5,
        12,
        2,
        15,
        8,
        6,
        1,
        4,
        11,
        13,
        12,
        3,
        7,
        14,
        10,
        15,
        6,
        8,
        0,
        5,
        9,
        2,
        6,
        11,
        13,
        8,
        1,
        4,
        10,
        7,
        9,
        5,
        0,
        15,
        14,
        2,
        3,
        12
      ],
      [
        13,
        2,
        8,
        4,
        6,
        15,
        11,
        1,
        10,
        9,
        3,
        14,
        5,
        0,
        12,
        7,
        1,
        15,
        13,
        8,
        10,
        3,
        7,
        4,
        12,
        5,
        6,
        11,
        0,
        14,
        9,
        2,
        7,
        11,
        4,
        1,
        9,
        12,
        14,
        2,
        0,
        6,
        10,
        13,
        15,
        3,
        5,
        8,
        2,
        1,
        14,
        7,
        4,
        10,
        8,
        13,
        15,
        12,
        9,
        0,
        3,
        5,
        6,
        11
      ]
    ];
  }
});

// src/sse.ts
async function* parseSSEMessages(stream, signal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        const dataLines = [];
        let event;
        let id;
        for (const line of lines) {
          if (!line || line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const field = separator === -1 ? line : line.slice(0, separator);
          let value2 = separator === -1 ? "" : line.slice(separator + 1);
          if (value2.startsWith(" ")) {
            value2 = value2.slice(1);
          }
          if (field === "data") {
            dataLines.push(value2);
          } else if (field === "event") {
            event = value2;
          } else if (field === "id") {
            id = value2;
          }
        }
        if (dataLines.length > 0 || event || id) {
          yield { data: dataLines.join("\n"), event, id };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
async function* parseSSEStream(stream, signal) {
  for await (const message of parseSSEMessages(stream, signal)) {
    if (!message.data) continue;
    try {
      yield JSON.parse(message.data);
    } catch {
    }
  }
}
var init_sse = __esm({
  "src/sse.ts"() {
    "use strict";
  }
});

// src/url.ts
function trimTrailingSlashes(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
function isLocalhost(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
function resolveProxyUrl(apiUrl) {
  const explicit = process.env.TENSORLAKE_SANDBOX_PROXY_URL;
  if (explicit) return explicit;
  if (isLocalhost(apiUrl)) return "http://localhost:9443";
  try {
    const parsed = new URL(apiUrl);
    const host = parsed.hostname;
    if (host.startsWith("api.")) {
      const proxyHost = "sandbox." + host.slice(4);
      return `${parsed.protocol}//${proxyHost}`;
    }
  } catch {
  }
  return SANDBOX_PROXY_URL;
}
function resolveProxyTarget(proxyUrl, sandboxId) {
  try {
    const parsed = new URL(proxyUrl);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return {
        baseUrl: trimTrailingSlashes(proxyUrl),
        hostHeader: `${sandboxId}.local`
      };
    }
    const port = parsed.port ? `:${parsed.port}` : "";
    return {
      baseUrl: `${parsed.protocol}//${sandboxId}.${host}${port}`,
      hostHeader: void 0
    };
  } catch {
    return {
      baseUrl: `${trimTrailingSlashes(proxyUrl)}/${sandboxId}`,
      hostHeader: void 0
    };
  }
}
function lifecyclePath(path2, isLocal, namespace) {
  if (isLocal) {
    return `/v1/namespaces/${namespace}/${path2}`;
  }
  return `/${path2}`;
}
var init_url = __esm({
  "src/url.ts"() {
    "use strict";
    init_defaults();
  }
});

// src/sandbox.ts
import WebSocket2 from "ws";
function normalizePtyMessage(message) {
  if (Buffer.isBuffer(message)) return message;
  if (Array.isArray(message)) {
    return Buffer.concat(message.map((part) => Buffer.from(part)));
  }
  return Buffer.from(message);
}
function encodePtyInput(input) {
  const payload = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return Buffer.concat([Buffer.from([PTY_OP_DATA]), payload]);
}
function encodePtyResize(cols, rows) {
  const frame = Buffer.alloc(5);
  frame[0] = PTY_OP_RESIZE;
  frame.writeUInt16BE(cols, 1);
  frame.writeUInt16BE(rows, 3);
  return frame;
}
function sendPtyFrame(socket, frame) {
  return new Promise((resolve, reject) => {
    socket.send(frame, (error) => error ? reject(error) : resolve());
  });
}
var PTY_OP_DATA, PTY_OP_RESIZE, PTY_OP_READY, PTY_OP_EXIT, Pty, Sandbox;
var init_sandbox = __esm({
  "src/sandbox.ts"() {
    "use strict";
    init_desktop();
    init_defaults();
    init_errors();
    init_http();
    init_models();
    init_tunnel();
    init_sse();
    init_url();
    PTY_OP_DATA = 0;
    PTY_OP_RESIZE = 1;
    PTY_OP_READY = 2;
    PTY_OP_EXIT = 3;
    Pty = class {
      sessionId;
      token;
      wsUrl;
      wsHeaders;
      killSession;
      socket = null;
      connectPromise = null;
      intentionalDisconnect = false;
      exitCode = null;
      waitSettled = false;
      dataHandlers = /* @__PURE__ */ new Set();
      exitHandlers = /* @__PURE__ */ new Set();
      waitPromise;
      resolveWait;
      rejectWait;
      constructor(options) {
        this.sessionId = options.sessionId;
        this.token = options.token;
        this.wsUrl = options.wsUrl;
        this.wsHeaders = options.wsHeaders;
        this.killSession = options.killSession;
        this.waitPromise = new Promise((resolve, reject) => {
          this.resolveWait = resolve;
          this.rejectWait = reject;
        });
      }
      onData(handler) {
        this.dataHandlers.add(handler);
        return () => this.dataHandlers.delete(handler);
      }
      onExit(handler) {
        this.exitHandlers.add(handler);
        if (this.exitCode != null) {
          queueMicrotask(() => handler(this.exitCode));
        }
        return () => this.exitHandlers.delete(handler);
      }
      async connect() {
        if (this.socket?.readyState === WebSocket2.OPEN) {
          return this;
        }
        if (this.connectPromise) {
          return this.connectPromise;
        }
        this.intentionalDisconnect = false;
        this.connectPromise = new Promise((resolve, reject) => {
          let opened = false;
          const socket = new WebSocket2(this.wsUrl, {
            headers: this.wsHeaders
          });
          this.socket = socket;
          socket.on("open", async () => {
            try {
              await sendPtyFrame(socket, Buffer.from([PTY_OP_READY]));
              opened = true;
              resolve(this);
            } catch (error) {
              reject(error);
            }
          });
          socket.on("message", (message) => {
            const bytes = normalizePtyMessage(message);
            const opcode = bytes[0];
            if (opcode === PTY_OP_DATA) {
              const payload = bytes.subarray(1);
              for (const handler of this.dataHandlers) {
                handler(payload);
              }
              return;
            }
            if (opcode === PTY_OP_EXIT && bytes.length >= 5) {
              this.finishWait(bytes.readInt32BE(1));
            }
          });
          socket.on("close", (code, reason) => {
            const closeReason = Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason);
            if (this.socket === socket) {
              this.socket = null;
            }
            this.connectPromise = null;
            if (this.exitCode != null) {
              this.finishWait(this.exitCode);
              return;
            }
            if (closeReason.startsWith("exit:")) {
              const parsed = Number.parseInt(closeReason.slice(5), 10);
              this.finishWait(Number.isNaN(parsed) ? -1 : parsed);
              return;
            }
            if (this.intentionalDisconnect) {
              this.intentionalDisconnect = false;
              return;
            }
            if (!opened) {
              reject(new SandboxError(
                `PTY websocket closed before READY completed: ${code} ${closeReason || "no reason"}`
              ));
              return;
            }
            if (closeReason === "session terminated") {
              this.failWait(new SandboxError("PTY session terminated"));
              return;
            }
            this.failWait(
              new SandboxError(
                `PTY websocket closed unexpectedly: ${code} ${closeReason || "no reason"}`
              )
            );
          });
          socket.on("error", (error) => {
            if (!opened) {
              reject(error);
            }
          });
        });
        return this.connectPromise;
      }
      async sendInput(input) {
        const socket = this.requireOpenSocket();
        await sendPtyFrame(socket, encodePtyInput(input));
      }
      async resize(cols, rows) {
        const socket = this.requireOpenSocket();
        await sendPtyFrame(socket, encodePtyResize(cols, rows));
      }
      disconnect(code = 1e3, reason = "client disconnect") {
        if (!this.socket) return;
        this.intentionalDisconnect = true;
        this.socket.close(code, reason);
      }
      wait() {
        return this.waitPromise;
      }
      async kill() {
        await this.killSession();
      }
      requireOpenSocket() {
        if (!this.socket || this.socket.readyState !== WebSocket2.OPEN) {
          throw new SandboxError("PTY is not connected");
        }
        return this.socket;
      }
      finishWait(exitCode) {
        if (this.waitSettled) return;
        this.waitSettled = true;
        this.exitCode = exitCode;
        for (const handler of this.exitHandlers) {
          handler(exitCode);
        }
        this.resolveWait(exitCode);
      }
      failWait(error) {
        if (this.waitSettled) return;
        this.waitSettled = true;
        this.rejectWait(error);
      }
    };
    Sandbox = class {
      sandboxId;
      traceId = null;
      http;
      baseUrl;
      wsHeaders;
      ownsSandbox = false;
      lifecycleClient = null;
      constructor(options) {
        this.sandboxId = options.sandboxId;
        const proxyUrl = options.proxyUrl ?? SANDBOX_PROXY_URL;
        const { baseUrl, hostHeader } = resolveProxyTarget(proxyUrl, options.sandboxId);
        this.baseUrl = baseUrl;
        this.wsHeaders = {};
        if (options.apiKey) {
          this.wsHeaders.Authorization = `Bearer ${options.apiKey}`;
        }
        if (options.organizationId) {
          this.wsHeaders["X-Forwarded-Organization-Id"] = options.organizationId;
        }
        if (options.projectId) {
          this.wsHeaders["X-Forwarded-Project-Id"] = options.projectId;
        }
        if (hostHeader) {
          this.wsHeaders.Host = hostHeader;
        }
        this.http = new HttpClient({
          baseUrl,
          apiKey: options.apiKey,
          organizationId: options.organizationId,
          projectId: options.projectId,
          hostHeader,
          routingHint: options.routingHint
        });
      }
      /** @internal Used by SandboxClient.createAndConnect to set ownership. */
      _setOwner(client) {
        this.ownsSandbox = true;
        this.lifecycleClient = client;
      }
      // --- Static factory methods ---
      /**
       * Create a new sandbox and return a connected, running handle.
       *
       * Covers both fresh sandbox creation and restore-from-snapshot (set
       * `snapshotId`). Blocks until the sandbox is `Running`.
       */
      static async create(options) {
        const { SandboxClient: SandboxClient2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = new SandboxClient2(
          options,
          /* _internal */
          true
        );
        const sandbox = await client.createAndConnect(options);
        sandbox.lifecycleClient = client;
        return sandbox;
      }
      /**
       * Attach to an existing sandbox and return a connected handle.
       *
       * Verifies the sandbox exists via a server GET call, then returns a handle
       * in whatever state the sandbox is in. Does **not** auto-resume a suspended
       * sandbox — call `sandbox.resume()` explicitly.
       */
      static async connect(options) {
        const { SandboxClient: SandboxClient2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = new SandboxClient2(
          options,
          /* _internal */
          true
        );
        await client.get(options.sandboxId);
        const sandbox = client.connect(options.sandboxId, options.proxyUrl, options.routingHint);
        sandbox.lifecycleClient = client;
        return sandbox;
      }
      // --- Static snapshot management ---
      /** Get information about a snapshot by ID. No sandbox handle needed. */
      static async getSnapshot(snapshotId, options) {
        const { SandboxClient: SandboxClient2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = new SandboxClient2(
          options,
          /* _internal */
          true
        );
        return client.getSnapshot(snapshotId);
      }
      /** Delete a snapshot by ID. No sandbox handle needed. */
      static async deleteSnapshot(snapshotId, options) {
        const { SandboxClient: SandboxClient2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = new SandboxClient2(
          options,
          /* _internal */
          true
        );
        await client.deleteSnapshot(snapshotId);
      }
      // --- Instance lifecycle methods ---
      requireLifecycleClient(operation) {
        if (!this.lifecycleClient) {
          throw new SandboxError(
            `Cannot ${operation}: no lifecycle client available. Use Sandbox.create() or Sandbox.connect() to get a lifecycle-aware handle.`
          );
        }
        return this.lifecycleClient;
      }
      /**
       * Suspend this sandbox.
       *
       * By default blocks until the sandbox is fully `Suspended`. Pass
       * `{ wait: false }` for fire-and-return.
       */
      async suspend(options) {
        const client = this.requireLifecycleClient("suspend");
        await client.suspend(this.sandboxId, options);
      }
      /**
       * Resume this sandbox.
       *
       * By default blocks until the sandbox is `Running` and routable. Pass
       * `{ wait: false }` for fire-and-return.
       */
      async resume(options) {
        const client = this.requireLifecycleClient("resume");
        await client.resume(this.sandboxId, options);
      }
      /**
       * Create a snapshot of this sandbox's filesystem and wait for it to
       * be committed.
       *
       * By default blocks until the snapshot artifact is ready and returns
       * the completed `SnapshotInfo`. Pass `{ wait: false }` to fire-and-return
       * (returns `undefined`).
       */
      async checkpoint(options) {
        const client = this.requireLifecycleClient("checkpoint");
        if (options?.wait === false) {
          await client.snapshot(this.sandboxId, { contentMode: options.contentMode });
          return void 0;
        }
        return client.snapshotAndWait(this.sandboxId, {
          timeout: options?.timeout,
          pollInterval: options?.pollInterval,
          contentMode: options?.contentMode
        });
      }
      /**
       * List snapshots taken from this sandbox.
       */
      async listSnapshots() {
        const client = this.requireLifecycleClient("listSnapshots");
        const all = await client.listSnapshots();
        return all.filter((s) => s.sandboxId === this.sandboxId);
      }
      /** Close the HTTP client. The sandbox keeps running. */
      close() {
        this.http.close();
      }
      /** Terminate the sandbox and release all resources. */
      async terminate() {
        const client = this.lifecycleClient;
        this.ownsSandbox = false;
        this.lifecycleClient = null;
        this.close();
        if (client) {
          await client.delete(this.sandboxId);
        }
      }
      // --- High-level convenience ---
      /**
       * Run a command to completion and return its output.
       *
       * Uses a single streaming `POST /api/v1/processes/run` request that starts
       * the process, streams output, and delivers the exit code over one connection.
       */
      async run(command, options) {
        const body = { command };
        if (options?.args) body.args = options.args;
        if (options?.env) body.env = options.env;
        if (options?.workingDir) body.working_dir = options.workingDir;
        if (options?.timeout != null) body.timeout = options.timeout;
        const sseStream = await this.http.requestStream(
          "POST",
          "/api/v1/processes/run",
          { json: body }
        );
        const stdoutLines = [];
        const stderrLines = [];
        let exitCode = -1;
        for await (const raw of parseSSEStream(sseStream)) {
          if (typeof raw.line === "string") {
            if (raw.stream === "stderr") {
              stderrLines.push(raw.line);
            } else {
              stdoutLines.push(raw.line);
            }
          } else if ("exit_code" in raw || "signal" in raw) {
            if (typeof raw.exit_code === "number") {
              exitCode = raw.exit_code;
            } else if (typeof raw.signal === "number") {
              exitCode = -raw.signal;
            }
          }
        }
        return {
          exitCode,
          stdout: stdoutLines.join("\n"),
          stderr: stderrLines.join("\n")
        };
      }
      // --- Process management ---
      /**
       * Start a process in the sandbox without waiting for it to exit.
       *
       * Returns a `ProcessInfo` with the assigned `pid`. Use `getProcess()` to
       * poll status, or `followStdout()` / `followOutput()` to stream output
       * until the process exits. Use `run()` instead to block until completion
       * and get combined output in one call.
       */
      async startProcess(command, options) {
        const payload = { command };
        if (options?.args != null) payload.args = options.args;
        if (options?.env != null) payload.env = options.env;
        if (options?.workingDir != null) payload.working_dir = options.workingDir;
        if (options?.stdinMode != null && options.stdinMode !== "closed" /* CLOSED */) {
          payload.stdin_mode = options.stdinMode;
        }
        if (options?.stdoutMode != null && options.stdoutMode !== "capture" /* CAPTURE */) {
          payload.stdout_mode = options.stdoutMode;
        }
        if (options?.stderrMode != null && options.stderrMode !== "capture" /* CAPTURE */) {
          payload.stderr_mode = options.stderrMode;
        }
        const raw = await this.http.requestJson(
          "POST",
          "/api/v1/processes",
          { body: payload }
        );
        return fromSnakeKeys(raw);
      }
      /** List all processes (running and exited) tracked by the sandbox daemon. */
      async listProcesses() {
        const raw = await this.http.requestJson(
          "GET",
          "/api/v1/processes"
        );
        return (raw.processes ?? []).map((p) => fromSnakeKeys(p));
      }
      /** Get current status and metadata for a process by PID. */
      async getProcess(pid) {
        const raw = await this.http.requestJson(
          "GET",
          `/api/v1/processes/${pid}`
        );
        return fromSnakeKeys(raw);
      }
      /** Send SIGKILL to a process. */
      async killProcess(pid) {
        await this.http.requestJson("DELETE", `/api/v1/processes/${pid}`);
      }
      /** Send an arbitrary signal to a process (e.g. `15` for SIGTERM, `9` for SIGKILL). */
      async sendSignal(pid, signal) {
        const raw = await this.http.requestJson(
          "POST",
          `/api/v1/processes/${pid}/signal`,
          { body: { signal } }
        );
        return fromSnakeKeys(raw);
      }
      // --- Process I/O ---
      /** Write bytes to a process's stdin. The process must have been started with `stdinMode: StdinMode.PIPE`. */
      async writeStdin(pid, data) {
        await this.http.requestBytes("POST", `/api/v1/processes/${pid}/stdin`, {
          body: data,
          contentType: "application/octet-stream"
        });
      }
      /** Close a process's stdin pipe, signalling EOF to the process. */
      async closeStdin(pid) {
        await this.http.requestJson("POST", `/api/v1/processes/${pid}/stdin/close`);
      }
      /** Return all captured stdout lines produced so far by a process. */
      async getStdout(pid) {
        const raw = await this.http.requestJson(
          "GET",
          `/api/v1/processes/${pid}/stdout`
        );
        return fromSnakeKeys(raw);
      }
      /** Return all captured stderr lines produced so far by a process. */
      async getStderr(pid) {
        const raw = await this.http.requestJson(
          "GET",
          `/api/v1/processes/${pid}/stderr`
        );
        return fromSnakeKeys(raw);
      }
      /** Return all captured stdout+stderr lines produced so far by a process. */
      async getOutput(pid) {
        const raw = await this.http.requestJson(
          "GET",
          `/api/v1/processes/${pid}/output`
        );
        return fromSnakeKeys(raw);
      }
      // --- Streaming (SSE) ---
      /** Stream stdout events from a process until it exits. Yields one `OutputEvent` per line. */
      async *followStdout(pid, options) {
        const stream = await this.http.requestStream(
          "GET",
          `/api/v1/processes/${pid}/stdout/follow`,
          options
        );
        for await (const raw of parseSSEStream(
          stream,
          options?.signal
        )) {
          yield fromSnakeKeys(raw);
        }
      }
      /** Stream stderr events from a process until it exits. Yields one `OutputEvent` per line. */
      async *followStderr(pid, options) {
        const stream = await this.http.requestStream(
          "GET",
          `/api/v1/processes/${pid}/stderr/follow`,
          options
        );
        for await (const raw of parseSSEStream(
          stream,
          options?.signal
        )) {
          yield fromSnakeKeys(raw);
        }
      }
      /** Stream combined stdout+stderr events from a process until it exits. Yields one `OutputEvent` per line. */
      async *followOutput(pid, options) {
        const stream = await this.http.requestStream(
          "GET",
          `/api/v1/processes/${pid}/output/follow`,
          options
        );
        for await (const raw of parseSSEStream(
          stream,
          options?.signal
        )) {
          yield fromSnakeKeys(raw);
        }
      }
      // --- File operations ---
      /** Read a file from the sandbox and return its raw bytes. */
      async readFile(path2) {
        return this.http.requestBytes(
          "GET",
          `/api/v1/files?path=${encodeURIComponent(path2)}`
        );
      }
      /** Write raw bytes to a file in the sandbox, creating it if it does not exist. */
      async writeFile(path2, content) {
        await this.http.requestBytes(
          "PUT",
          `/api/v1/files?path=${encodeURIComponent(path2)}`,
          { body: content, contentType: "application/octet-stream" }
        );
      }
      /** Delete a file from the sandbox. */
      async deleteFile(path2) {
        await this.http.requestJson(
          "DELETE",
          `/api/v1/files?path=${encodeURIComponent(path2)}`
        );
      }
      /** List the contents of a directory in the sandbox. */
      async listDirectory(path2) {
        const raw = await this.http.requestJson(
          "GET",
          `/api/v1/files/list?path=${encodeURIComponent(path2)}`
        );
        return fromSnakeKeys(raw);
      }
      // --- PTY ---
      /** Create an interactive PTY session. Returns a `sessionId` and `token` for WebSocket connection via `connectPty()`. */
      async createPtySession(options) {
        const payload = {
          command: options.command,
          rows: options.rows ?? 24,
          cols: options.cols ?? 80
        };
        if (options.args != null) payload.args = options.args;
        if (options.env != null) payload.env = options.env;
        if (options.workingDir != null) payload.working_dir = options.workingDir;
        const raw = await this.http.requestJson(
          "POST",
          "/api/v1/pty",
          { body: payload }
        );
        return fromSnakeKeys(raw);
      }
      /** Create a PTY session and connect to it immediately. Cleans up the session if the WebSocket connection fails. */
      async createPty(options) {
        const { onData, onExit, ...createOptions } = options;
        const session = await this.createPtySession(createOptions);
        try {
          return await this.connectPty(session.sessionId, session.token, { onData, onExit });
        } catch (error) {
          try {
            await this.http.requestResponse("DELETE", `/api/v1/pty/${session.sessionId}`);
          } catch {
          }
          throw error;
        }
      }
      /** Attach to an existing PTY session by ID and token and return a connected `Pty` handle. */
      async connectPty(sessionId, token, options) {
        const wsUrl = new URL(this.ptyWsUrl(sessionId, token));
        const authToken = wsUrl.searchParams.get("token") ?? token;
        const pty = new Pty({
          sessionId,
          token: authToken,
          wsUrl: wsUrl.toString(),
          wsHeaders: {
            ...this.wsHeaders,
            "X-PTY-Token": authToken
          },
          killSession: async () => {
            await this.http.requestResponse("DELETE", `/api/v1/pty/${sessionId}`);
          }
        });
        if (options?.onData) {
          pty.onData(options.onData);
        }
        if (options?.onExit) {
          pty.onExit(options.onExit);
        }
        await pty.connect();
        return pty;
      }
      /** Open a TCP tunnel to a port inside the sandbox and return the local listener. */
      async createTunnel(remotePort, options) {
        return TcpTunnel.listen({
          baseUrl: this.baseUrl,
          wsHeaders: this.wsHeaders,
          remotePort,
          localHost: options?.localHost,
          localPort: options?.localPort,
          connectTimeout: options?.connectTimeout
        });
      }
      /** Connect to a sandbox VNC session for programmatic desktop control. */
      async connectDesktop(options) {
        return Desktop.connect({
          baseUrl: this.baseUrl,
          wsHeaders: this.wsHeaders,
          port: options?.port,
          password: options?.password,
          shared: options?.shared,
          connectTimeout: options?.connectTimeout
        });
      }
      ptyWsUrl(sessionId, token) {
        let wsBase;
        if (this.baseUrl.startsWith("https://")) {
          wsBase = "wss://" + this.baseUrl.slice(8);
        } else if (this.baseUrl.startsWith("http://")) {
          wsBase = "ws://" + this.baseUrl.slice(7);
        } else {
          wsBase = this.baseUrl;
        }
        return `${wsBase}/api/v1/pty/${sessionId}/ws?token=${token}`;
      }
      // --- Health ---
      /** Check the sandbox daemon health. */
      async health() {
        const raw = await this.http.requestJson(
          "GET",
          "/api/v1/health"
        );
        return fromSnakeKeys(raw);
      }
      /** Get sandbox daemon info (version, uptime, process counts). */
      async info() {
        const raw = await this.http.requestJson(
          "GET",
          "/api/v1/info"
        );
        return fromSnakeKeys(raw);
      }
    };
  }
});

// src/client.ts
var client_exports = {};
__export(client_exports, {
  SandboxClient: () => SandboxClient
});
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeUserPorts(ports) {
  return dedupeAndSortPorts(ports.map(validateUserPort));
}
function validateUserPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SandboxError(`invalid port '${port}'`);
  }
  if (port === RESERVED_SANDBOX_MANAGEMENT_PORT) {
    throw new SandboxError("port 9501 is reserved for sandbox management");
  }
  return port;
}
function dedupeAndSortPorts(ports) {
  return [...new Set(ports)].sort((a, b) => a - b);
}
var SandboxClient, RESERVED_SANDBOX_MANAGEMENT_PORT;
var init_client = __esm({
  "src/client.ts"() {
    "use strict";
    init_defaults();
    init_errors();
    init_http();
    init_models();
    init_sandbox();
    init_url();
    SandboxClient = class _SandboxClient {
      http;
      apiUrl;
      apiKey;
      organizationId;
      projectId;
      namespace;
      local;
      /** @internal Pass `true` to suppress the deprecation warning when used by `Sandbox.create()` / `Sandbox.connect()`. */
      constructor(options, _internal = false) {
        if (!_internal) {
          console.warn(
            "[tensorlake] SandboxClient is deprecated; use Sandbox.create() / Sandbox.connect() instead."
          );
        }
        this.apiUrl = options?.apiUrl ?? API_URL;
        this.apiKey = options?.apiKey ?? API_KEY;
        this.organizationId = options?.organizationId;
        this.projectId = options?.projectId;
        this.namespace = options?.namespace ?? NAMESPACE;
        this.local = isLocalhost(this.apiUrl);
        this.http = new HttpClient({
          baseUrl: this.apiUrl,
          apiKey: this.apiKey,
          organizationId: this.organizationId,
          projectId: this.projectId,
          maxRetries: options?.maxRetries ?? MAX_RETRIES,
          retryBackoffMs: options?.retryBackoffMs ?? RETRY_BACKOFF_MS
        });
      }
      /** Create a client for the TensorLake cloud platform. */
      static forCloud(options) {
        return new _SandboxClient({
          apiUrl: options?.apiUrl ?? "https://api.tensorlake.ai",
          apiKey: options?.apiKey,
          organizationId: options?.organizationId,
          projectId: options?.projectId
        });
      }
      /** Create a client for a local Indexify server. */
      static forLocalhost(options) {
        return new _SandboxClient({
          apiUrl: options?.apiUrl ?? "http://localhost:8900",
          namespace: options?.namespace ?? "default"
        });
      }
      close() {
        this.http.close();
      }
      // --- Path helper ---
      path(subpath) {
        return lifecyclePath(subpath, this.local, this.namespace);
      }
      // --- Sandbox CRUD ---
      /** Create a new sandbox. Returns immediately; the sandbox may still be starting. Use `createAndConnect()` for a blocking, ready-to-use handle. */
      async create(options) {
        const body = {
          resources: {
            cpus: options?.cpus ?? 1,
            memory_mb: options?.memoryMb ?? 1024,
            ...(options?.diskMb != null ? { disk_mb: options.diskMb } : {}) // PATCHED 2026-10-19: ephemeral_disk_mb deprecated by API
          }
        };
        if (options?.image != null) body.image = options.image;
        if (options?.secretNames != null) body.secret_names = options.secretNames;
        if (options?.timeoutSecs != null) body.timeout_secs = options.timeoutSecs;
        if (options?.entrypoint != null) body.entrypoint = options.entrypoint;
        if (options?.snapshotId != null) body.snapshot_id = options.snapshotId;
        if (options?.name != null) body.name = options.name;
        if (options?.allowInternetAccess === false || options?.allowOut != null || options?.denyOut != null) {
          body.network = {
            allow_internet_access: options?.allowInternetAccess ?? true,
            allow_out: options?.allowOut ?? [],
            deny_out: options?.denyOut ?? []
          };
        }
        const raw = await this.http.requestJson(
          "POST",
          this.path("sandboxes"),
          { body }
        );
        const result = fromSnakeKeys(raw, "sandboxId");
        return Object.assign(result, { traceId: raw.traceId });
      }
      /** Get current state and metadata for a sandbox by ID. */
      async get(sandboxId) {
        const raw = await this.http.requestJson(
          "GET",
          this.path(`sandboxes/${sandboxId}`)
        );
        return fromSnakeKeys(raw, "sandboxId");
      }
      /** List all sandboxes in the namespace. */
      async list() {
        const raw = await this.http.requestJson(
          "GET",
          this.path("sandboxes")
        );
        return (raw.sandboxes ?? []).map(
          (s) => fromSnakeKeys(s, "sandboxId")
        );
      }
      /** Update sandbox properties such as name, exposed ports, and proxy auth settings. */
      async update(sandboxId, options) {
        const body = {};
        if (options.name != null) body.name = options.name;
        if (options.allowUnauthenticatedAccess != null) {
          body.allow_unauthenticated_access = options.allowUnauthenticatedAccess;
        }
        if (options.exposedPorts != null) {
          body.exposed_ports = normalizeUserPorts(options.exposedPorts);
        }
        if (Object.keys(body).length === 0) {
          throw new SandboxError("At least one sandbox update field must be provided.");
        }
        const raw = await this.http.requestJson(
          "PATCH",
          this.path(`sandboxes/${sandboxId}`),
          { body }
        );
        return fromSnakeKeys(raw, "sandboxId");
      }
      /** Get the current proxy port settings for a sandbox. */
      async getPortAccess(sandboxId) {
        const info = await this.get(sandboxId);
        return {
          allowUnauthenticatedAccess: info.allowUnauthenticatedAccess ?? false,
          exposedPorts: dedupeAndSortPorts(info.exposedPorts ?? []),
          sandboxUrl: info.sandboxUrl
        };
      }
      /** Add one or more user ports to the sandbox proxy allowlist. */
      async exposePorts(sandboxId, ports, options) {
        const requestedPorts = normalizeUserPorts(ports);
        const current = await this.getPortAccess(sandboxId);
        const desiredPorts = dedupeAndSortPorts([
          ...current.exposedPorts,
          ...requestedPorts
        ]);
        return this.update(sandboxId, {
          allowUnauthenticatedAccess: options?.allowUnauthenticatedAccess ?? current.allowUnauthenticatedAccess,
          exposedPorts: desiredPorts
        });
      }
      /** Remove one or more user ports from the sandbox proxy allowlist. */
      async unexposePorts(sandboxId, ports) {
        const requestedPorts = normalizeUserPorts(ports);
        const current = await this.getPortAccess(sandboxId);
        const toRemove = new Set(requestedPorts);
        const desiredPorts = current.exposedPorts.filter((port) => !toRemove.has(port));
        return this.update(sandboxId, {
          allowUnauthenticatedAccess: desiredPorts.length ? current.allowUnauthenticatedAccess : false,
          exposedPorts: desiredPorts
        });
      }
      /** Terminate and delete a sandbox. */
      async delete(sandboxId) {
        await this.http.requestJson(
          "DELETE",
          this.path(`sandboxes/${sandboxId}`)
        );
      }
      /**
       * Suspend a named sandbox, preserving its state for later resume.
       *
       * Only sandboxes created with a `name` can be suspended; ephemeral sandboxes
       * cannot. By default blocks until the sandbox is fully `Suspended`. Pass
       * `{ wait: false }` to return immediately after the request is sent
       * (fire-and-return); the server processes the suspend asynchronously.
       *
       * @param sandboxId - ID or name of the sandbox.
       * @param options.wait - If `true` (default), poll until `Suspended`. Pass `false` to fire-and-return.
       * @param options.timeout - Max seconds to wait when `wait=true` (default 300).
       * @param options.pollInterval - Seconds between status polls when `wait=true` (default 1).
       * @throws {SandboxError} If `wait=true` and the sandbox does not reach `Suspended` within `timeout`.
       */
      async suspend(sandboxId, options) {
        await this.http.requestResponse(
          "POST",
          this.path(`sandboxes/${sandboxId}/suspend`)
        );
        if (options?.wait === false) return;
        const timeout = options?.timeout ?? 300;
        const pollInterval = options?.pollInterval ?? 1;
        const deadline = Date.now() + timeout * 1e3;
        while (Date.now() < deadline) {
          const info = await this.get(sandboxId);
          if (info.status === "suspended" /* SUSPENDED */) return;
          if (info.status === "terminated" /* TERMINATED */) {
            throw new SandboxError(`Sandbox ${sandboxId} terminated while waiting for suspend`);
          }
          await sleep2(pollInterval * 1e3);
        }
        throw new SandboxError(`Sandbox ${sandboxId} did not suspend within ${timeout}s`);
      }
      /**
       * Resume a suspended sandbox and bring it back to `Running`.
       *
       * By default blocks until the sandbox is `Running` and routable. Pass
       * `{ wait: false }` to return immediately after the request is sent
       * (fire-and-return); the server processes the resume asynchronously.
       *
       * @param sandboxId - ID or name of the sandbox.
       * @param options.wait - If `true` (default), poll until `Running`. Pass `false` to fire-and-return.
       * @param options.timeout - Max seconds to wait when `wait=true` (default 300).
       * @param options.pollInterval - Seconds between status polls when `wait=true` (default 1).
       * @throws {SandboxError} If `wait=true` and the sandbox does not reach `Running` within `timeout`.
       */
      async resume(sandboxId, options) {
        await this.http.requestResponse(
          "POST",
          this.path(`sandboxes/${sandboxId}/resume`)
        );
        if (options?.wait === false) return;
        const timeout = options?.timeout ?? 300;
        const pollInterval = options?.pollInterval ?? 1;
        const deadline = Date.now() + timeout * 1e3;
        while (Date.now() < deadline) {
          const info = await this.get(sandboxId);
          if (info.status === "running" /* RUNNING */) return;
          if (info.status === "terminated" /* TERMINATED */) {
            throw new SandboxError(`Sandbox ${sandboxId} terminated while waiting for resume`);
          }
          await sleep2(pollInterval * 1e3);
        }
        throw new SandboxError(`Sandbox ${sandboxId} did not resume within ${timeout}s`);
      }
      /** Claim a warm sandbox from a pool, creating one if no warm containers are available. */
      async claim(poolId) {
        const raw = await this.http.requestJson(
          "POST",
          this.path(`sandbox-pools/${poolId}/sandboxes`)
        );
        const result = fromSnakeKeys(raw, "sandboxId");
        return Object.assign(result, { traceId: raw.traceId });
      }
      // --- Snapshots ---
      /**
       * Request a snapshot of a running sandbox's filesystem.
       *
       * This call **returns immediately** with a `snapshotId` and `in_progress`
       * status — the snapshot is created asynchronously. Poll `getSnapshot()` until
       * `completed` or `failed`, or use `snapshotAndWait()` to block automatically.
       *
       * @param options.contentMode - `"filesystem_only"` for cold-boot snapshots (e.g. image builds).
       *   Omit to use the server default (full VM snapshot).
       */
      async snapshot(sandboxId, options) {
        const requestOptions = options?.contentMode != null ? { body: { snapshot_content_mode: options.contentMode } } : void 0;
        const raw = await this.http.requestJson(
          "POST",
          this.path(`sandboxes/${sandboxId}/snapshot`),
          requestOptions
        );
        return fromSnakeKeys(raw, "snapshotId");
      }
      /** Get current status and metadata for a snapshot by ID. */
      async getSnapshot(snapshotId) {
        const raw = await this.http.requestJson(
          "GET",
          this.path(`snapshots/${snapshotId}`)
        );
        return fromSnakeKeys(raw, "snapshotId");
      }
      /** List all snapshots in the namespace. */
      async listSnapshots() {
        const raw = await this.http.requestJson(
          "GET",
          this.path("snapshots")
        );
        return (raw.snapshots ?? []).map(
          (s) => fromSnakeKeys(s, "snapshotId")
        );
      }
      /** Delete a snapshot by ID. */
      async deleteSnapshot(snapshotId) {
        await this.http.requestJson(
          "DELETE",
          this.path(`snapshots/${snapshotId}`)
        );
      }
      /**
       * Create a snapshot and block until it is committed.
       *
       * Combines `snapshot()` with polling `getSnapshot()` until `completed`.
       * Prefer `sandbox.checkpoint()` on a `Sandbox` handle for the same behavior
       * without managing the client separately.
       *
       * @param sandboxId - ID of the running sandbox to snapshot.
       * @param options.timeout - Max seconds to wait (default 300).
       * @param options.pollInterval - Seconds between status polls (default 1).
       * @param options.contentMode - Content mode passed through to `snapshot()`.
       * @throws {SandboxError} If the snapshot fails or `timeout` elapses.
       */
      async snapshotAndWait(sandboxId, options) {
        const timeout = options?.timeout ?? 300;
        const pollInterval = options?.pollInterval ?? 1;
        const result = await this.snapshot(sandboxId, {
          contentMode: options?.contentMode
        });
        const deadline = Date.now() + timeout * 1e3;
        while (Date.now() < deadline) {
          const info = await this.getSnapshot(result.snapshotId);
          if (info.status === "completed" /* COMPLETED */) return info;
          if (info.status === "failed" /* FAILED */) {
            throw new SandboxError(
              `Snapshot ${result.snapshotId} failed: ${info.error}`
            );
          }
          await sleep2(pollInterval * 1e3);
        }
        throw new SandboxError(
          `Snapshot ${result.snapshotId} did not complete within ${timeout}s`
        );
      }
      // --- Pools ---
      /** Create a new sandbox pool with warm pre-booted containers. */
      async createPool(options) {
        const body = {
          image: options.image,
          resources: {
            cpus: options.cpus ?? 1,
            memory_mb: options.memoryMb ?? 1024,
            ...(options.ephemeralDiskMb != null ? { disk_mb: options.ephemeralDiskMb } : {})
          },
          timeout_secs: options.timeoutSecs ?? 0
        };
        if (options.secretNames != null) body.secret_names = options.secretNames;
        if (options.entrypoint != null) body.entrypoint = options.entrypoint;
        if (options.maxContainers != null) body.max_containers = options.maxContainers;
        if (options.warmContainers != null) body.warm_containers = options.warmContainers;
        const raw = await this.http.requestJson(
          "POST",
          this.path("sandbox-pools"),
          { body }
        );
        return fromSnakeKeys(raw, "poolId");
      }
      /** Get current state and metadata for a sandbox pool by ID. */
      async getPool(poolId) {
        const raw = await this.http.requestJson(
          "GET",
          this.path(`sandbox-pools/${poolId}`)
        );
        return fromSnakeKeys(raw, "poolId");
      }
      /** List all sandbox pools in the namespace. */
      async listPools() {
        const raw = await this.http.requestJson(
          "GET",
          this.path("sandbox-pools")
        );
        return (raw.pools ?? []).map(
          (p) => fromSnakeKeys(p, "poolId")
        );
      }
      /** Replace the configuration of an existing sandbox pool. */
      async updatePool(poolId, options) {
        const body = {
          image: options.image,
          resources: {
            cpus: options.cpus ?? 1,
            memory_mb: options.memoryMb ?? 1024,
            ...(options.ephemeralDiskMb != null ? { disk_mb: options.ephemeralDiskMb } : {})
          },
          timeout_secs: options.timeoutSecs ?? 0
        };
        if (options.secretNames != null) body.secret_names = options.secretNames;
        if (options.entrypoint != null) body.entrypoint = options.entrypoint;
        if (options.maxContainers != null) body.max_containers = options.maxContainers;
        if (options.warmContainers != null) body.warm_containers = options.warmContainers;
        const raw = await this.http.requestJson(
          "PUT",
          this.path(`sandbox-pools/${poolId}`),
          { body }
        );
        return fromSnakeKeys(raw, "poolId");
      }
      /** Delete a sandbox pool. Fails if the pool has active containers. */
      async deletePool(poolId) {
        await this.http.requestJson(
          "DELETE",
          this.path(`sandbox-pools/${poolId}`)
        );
      }
      // --- Connect ---
      /** Return a `Sandbox` handle for an existing running sandbox without verifying it exists. */
      connect(identifier, proxyUrl, routingHint) {
        const resolvedProxy = proxyUrl ?? resolveProxyUrl(this.apiUrl);
        return new Sandbox({
          sandboxId: identifier,
          proxyUrl: resolvedProxy,
          apiKey: this.apiKey,
          organizationId: this.organizationId,
          projectId: this.projectId,
          routingHint
        });
      }
      /**
       * Create a sandbox, wait for it to reach `Running`, and return a connected handle.
       *
       * Blocks until the sandbox is ready or `startupTimeout` elapses. The returned
       * `Sandbox` auto-terminates when `terminate()` is called.
       *
       * @param options.startupTimeout - Max seconds to wait for `Running` status (default 60).
       * @throws {SandboxError} If the sandbox terminates during startup or the timeout elapses.
       */
      async createAndConnect(options) {
        const startupTimeout = options?.startupTimeout ?? 60;
        let result;
        if (options?.poolId != null) {
          result = await this.claim(options.poolId);
        } else {
          result = await this.create(options);
        }
        if (result.status === "running" /* RUNNING */) {
          const sandbox = this.connect(result.sandboxId, options?.proxyUrl, result.routingHint);
          sandbox._setOwner(this);
          sandbox.traceId = result.traceId;
          return sandbox;
        }
        const deadline = Date.now() + startupTimeout * 1e3;
        while (Date.now() < deadline) {
          const info = await this.get(result.sandboxId);
          if (info.status === "running" /* RUNNING */) {
            const sandbox = this.connect(result.sandboxId, options?.proxyUrl, info.routingHint);
            sandbox._setOwner(this);
            sandbox.traceId = result.traceId;
            return sandbox;
          }
          if (info.status === "terminated" /* TERMINATED */) {
            throw new SandboxError(
              `Sandbox ${result.sandboxId} terminated during startup`
            );
          }
          await sleep2(500);
        }
        try {
          await this.delete(result.sandboxId);
        } catch {
        }
        throw new SandboxError(
          `Sandbox ${result.sandboxId} did not start within ${startupTimeout}s`
        );
      }
    };
    RESERVED_SANDBOX_MANAGEMENT_PORT = 9501;
  }
});

// src/image.ts
import { randomUUID } from "crypto";
function cloneOperation(op) {
  return {
    type: op.type,
    args: [...op.args],
    options: { ...op.options }
  };
}
function renderOptions(options) {
  const entries = Object.entries(options);
  if (entries.length === 0) {
    return "";
  }
  return ` ${entries.map(([key, value]) => `--${key}=${value}`).join(" ")}`;
}
function renderBuildOp(op) {
  const options = renderOptions(op.options);
  if (op.type === ImageBuildOperationType.ENV) {
    return `ENV${options} ${op.args[0]}=${JSON.stringify(op.args[1])}`;
  }
  return `${op.type}${options} ${op.args.join(" ")}`;
}
function dockerfileContent(image) {
  const lines = image.baseImage == null ? [] : [`FROM ${image.baseImage}`];
  lines.push(...image.buildOperations.map((op) => renderBuildOp(op)));
  return lines.join("\n");
}
var DEFAULT_IMAGE_NAME, ImageBuildOperationType, Image;
var init_image = __esm({
  "src/image.ts"() {
    "use strict";
    DEFAULT_IMAGE_NAME = "default";
    ImageBuildOperationType = {
      ADD: "ADD",
      COPY: "COPY",
      ENV: "ENV",
      RUN: "RUN",
      WORKDIR: "WORKDIR"
    };
    Image = class {
      _id;
      _name;
      _tag;
      _baseImage;
      _buildOperations;
      constructor(nameOrOptions = {}, tag = "latest", baseImage = null) {
        this._id = randomUUID();
        this._buildOperations = [];
        if (typeof nameOrOptions === "string") {
          this._name = nameOrOptions;
          this._tag = tag;
          this._baseImage = baseImage;
          return;
        }
        this._name = nameOrOptions.name ?? DEFAULT_IMAGE_NAME;
        this._tag = nameOrOptions.tag ?? "latest";
        this._baseImage = nameOrOptions.baseImage ?? null;
      }
      get name() {
        return this._name;
      }
      get tag() {
        return this._tag;
      }
      get baseImage() {
        return this._baseImage;
      }
      get buildOperations() {
        return this._buildOperations.map(cloneOperation);
      }
      add(src, dest, options = void 0) {
        return this._addOperation({
          type: ImageBuildOperationType.ADD,
          args: [src, dest],
          options: options == null ? {} : { ...options }
        });
      }
      copy(src, dest, options = void 0) {
        return this._addOperation({
          type: ImageBuildOperationType.COPY,
          args: [src, dest],
          options: options == null ? {} : { ...options }
        });
      }
      env(key, value) {
        return this._addOperation({
          type: ImageBuildOperationType.ENV,
          args: [key, value],
          options: {}
        });
      }
      run(commands, options = void 0) {
        return this._addOperation({
          type: ImageBuildOperationType.RUN,
          args: Array.isArray(commands) ? [...commands] : [commands],
          options: options == null ? {} : { ...options }
        });
      }
      workdir(directory) {
        return this._addOperation({
          type: ImageBuildOperationType.WORKDIR,
          args: [directory],
          options: {}
        });
      }
      /**
       * Build this image as a sandbox template and register it.
       *
       * Materializes the image in a build sandbox, snapshots the filesystem,
       * and registers the snapshot as a named sandbox template.
       */
      async build(options = {}) {
        if ((options.registeredName ?? this._name) === DEFAULT_IMAGE_NAME) {
          console.warn(
            `Building sandbox image with the default name "${DEFAULT_IMAGE_NAME}". Pass \`registeredName\` or \`Image({ name })\` to avoid collisions with other default-named images in this project.`
          );
        }
        const { createSandboxImage: createSandboxImage2 } = await Promise.resolve().then(() => (init_sandbox_image(), sandbox_image_exports));
        return createSandboxImage2(this, options);
      }
      _addOperation(op) {
        this._buildOperations.push(op);
        return this;
      }
    };
  }
});

// src/sandbox-image.ts
var sandbox_image_exports = {};
__export(sandbox_image_exports, {
  createSandboxImage: () => createSandboxImage,
  defaultRegisteredName: () => defaultRegisteredName,
  loadDockerfilePlan: () => loadDockerfilePlan,
  loadImagePlan: () => loadImagePlan,
  logicalDockerfileLines: () => logicalDockerfileLines,
  runCreateSandboxImageCli: () => runCreateSandboxImageCli
});
import { readFile, readdir, stat } from "fs/promises";
import path from "path";
import { parseArgs } from "util";
function defaultRegisteredName(dockerfilePath) {
  const parsed = path.parse(dockerfilePath);
  if (parsed.name.toLowerCase() === "dockerfile") {
    const parentName = path.basename(path.dirname(dockerfilePath)).trim();
    return parentName || "sandbox-image";
  }
  return parsed.name || "sandbox-image";
}
function logicalDockerfileLines(dockerfileText) {
  const logicalLines = [];
  let parts = [];
  let startLine = null;
  for (const [index, rawLine] of dockerfileText.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const stripped = rawLine.trim();
    if (parts.length === 0 && (!stripped || stripped.startsWith("#"))) {
      continue;
    }
    if (startLine == null) {
      startLine = lineNumber;
    }
    let line = rawLine.replace(/\s+$/, "");
    const continued = line.endsWith("\\");
    if (continued) {
      line = line.slice(0, -1);
    }
    const normalized = line.trim();
    if (normalized && !normalized.startsWith("#")) {
      parts.push(normalized);
    }
    if (continued) {
      continue;
    }
    if (parts.length > 0) {
      logicalLines.push({
        lineNumber: startLine ?? lineNumber,
        line: parts.join(" ")
      });
    }
    parts = [];
    startLine = null;
  }
  if (parts.length > 0) {
    logicalLines.push({
      lineNumber: startLine ?? 1,
      line: parts.join(" ")
    });
  }
  return logicalLines;
}
function splitInstruction(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error(`line ${lineNumber}: empty Dockerfile instruction`);
  }
  const match = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) {
    throw new Error(`line ${lineNumber}: invalid Dockerfile instruction`);
  }
  return {
    keyword: match[1].toUpperCase(),
    value: (match[2] ?? "").trim()
  };
}
function shellSplit(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (quote == null) {
      if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      current += char;
      continue;
    }
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quote = null;
      continue;
    }
    if (char === "\\") {
      const next = input[++i];
      if (next == null) {
        throw new Error(`unterminated escape sequence in '${input}'`);
      }
      current += next;
      continue;
    }
    current += char;
  }
  if (escape) {
    throw new Error(`unterminated escape sequence in '${input}'`);
  }
  if (quote != null) {
    throw new Error(`unterminated quoted string in '${input}'`);
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
function shellQuote(value) {
  if (!value) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function stripLeadingFlags(value) {
  const flags = {};
  let remaining = value.trimStart();
  while (remaining.startsWith("--")) {
    const firstSpace = remaining.indexOf(" ");
    if (firstSpace === -1) {
      throw new Error(`invalid Dockerfile flag syntax: ${value}`);
    }
    const token = remaining.slice(0, firstSpace);
    const rest = remaining.slice(firstSpace + 1).trimStart();
    const flagBody = token.slice(2);
    if (flagBody.includes("=")) {
      const [key, flagValue2] = flagBody.split(/=(.*)/s, 2);
      flags[key] = flagValue2;
      remaining = rest;
      continue;
    }
    const [flagValue, ...restTokens] = shellSplit(rest);
    if (flagValue == null) {
      throw new Error(`missing value for Dockerfile flag '${token}'`);
    }
    flags[flagBody] = flagValue;
    remaining = restTokens.join(" ");
  }
  return { flags, remaining };
}
function parseFromValue(value, lineNumber) {
  const { remaining } = stripLeadingFlags(value);
  const tokens = shellSplit(remaining);
  if (tokens.length === 0) {
    throw new Error(`line ${lineNumber}: FROM must include a base image`);
  }
  if (tokens.length > 1 && tokens[1].toLowerCase() !== "as") {
    throw new Error(`line ${lineNumber}: unsupported FROM syntax '${value}'`);
  }
  return tokens[0];
}
function parseCopyLikeValues(value, lineNumber, keyword) {
  const { flags, remaining } = stripLeadingFlags(value);
  if ("from" in flags) {
    throw new Error(
      `line ${lineNumber}: ${keyword} --from is not supported for sandbox image creation`
    );
  }
  const payload = remaining.trim();
  if (!payload) {
    throw new Error(
      `line ${lineNumber}: ${keyword} must include source and destination`
    );
  }
  let parts;
  if (payload.startsWith("[")) {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(
        `line ${lineNumber}: invalid JSON array syntax for ${keyword}: ${error.message}`
      );
    }
    if (!Array.isArray(parsed) || parsed.length < 2 || parsed.some((item) => typeof item !== "string")) {
      throw new Error(
        `line ${lineNumber}: ${keyword} JSON array form requires at least two string values`
      );
    }
    parts = parsed;
  } else {
    parts = shellSplit(payload);
    if (parts.length < 2) {
      throw new Error(
        `line ${lineNumber}: ${keyword} must include at least one source and one destination`
      );
    }
  }
  return {
    flags,
    sources: parts.slice(0, -1),
    destination: parts[parts.length - 1]
  };
}
function parseEnvPairs(value, lineNumber) {
  const tokens = shellSplit(value);
  if (tokens.length === 0) {
    throw new Error(`line ${lineNumber}: ENV must include a key and value`);
  }
  if (tokens.every((token) => token.includes("="))) {
    return tokens.map((token) => {
      const [key, envValue] = token.split(/=(.*)/s, 2);
      if (!key) {
        throw new Error(`line ${lineNumber}: invalid ENV token '${token}'`);
      }
      return [key, envValue];
    });
  }
  if (tokens.length < 2) {
    throw new Error(`line ${lineNumber}: ENV must include a key and value`);
  }
  return [[tokens[0], tokens.slice(1).join(" ")]];
}
function resolveContainerPath(containerPath, workingDir) {
  if (!containerPath) {
    return workingDir;
  }
  const normalized = containerPath.startsWith("/") ? path.posix.normalize(containerPath) : path.posix.normalize(path.posix.join(workingDir, containerPath));
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
function buildPlanFromDockerfileText(dockerfileText, dockerfilePath, contextDir, registeredName) {
  let baseImage;
  const instructions = [];
  for (const logicalLine of logicalDockerfileLines(dockerfileText)) {
    const { keyword, value } = splitInstruction(
      logicalLine.line,
      logicalLine.lineNumber
    );
    if (keyword === "FROM") {
      if (baseImage != null) {
        throw new Error(
          `line ${logicalLine.lineNumber}: multi-stage Dockerfiles are not supported for sandbox image creation`
        );
      }
      baseImage = parseFromValue(value, logicalLine.lineNumber);
      continue;
    }
    if (UNSUPPORTED_DOCKERFILE_INSTRUCTIONS.has(keyword)) {
      throw new Error(
        `line ${logicalLine.lineNumber}: Dockerfile instruction '${keyword}' is not supported for sandbox image creation`
      );
    }
    instructions.push({
      keyword,
      value,
      lineNumber: logicalLine.lineNumber
    });
  }
  if (!baseImage) {
    throw new Error("Dockerfile must contain a FROM instruction");
  }
  return {
    dockerfilePath,
    contextDir,
    registeredName: registeredName ?? defaultRegisteredName(dockerfilePath),
    dockerfileText,
    baseImage,
    instructions
  };
}
async function loadDockerfilePlan(dockerfilePath, registeredName) {
  const resolvedPath = path.resolve(dockerfilePath);
  const fileStats = await stat(resolvedPath).catch(() => null);
  if (!fileStats?.isFile()) {
    throw new Error(`Dockerfile not found: ${dockerfilePath}`);
  }
  const dockerfileText = await readFile(resolvedPath, "utf8");
  return buildPlanFromDockerfileText(
    dockerfileText,
    resolvedPath,
    path.dirname(resolvedPath),
    registeredName
  );
}
function loadImagePlan(image, options = {}) {
  const contextDir = path.resolve(options.contextDir ?? process.cwd());
  const dockerfileText = dockerfileContent(image);
  const logicalLines = logicalDockerfileLines(dockerfileText);
  const instructions = image.baseImage == null ? logicalLines : logicalLines.slice(1);
  return {
    dockerfilePath: path.join(contextDir, "Dockerfile"),
    contextDir,
    registeredName: options.registeredName ?? image.name,
    dockerfileText,
    baseImage: image.baseImage ?? void 0,
    instructions: instructions.map(({ line, lineNumber }) => {
      const parsed = splitInstruction(line, lineNumber);
      return {
        keyword: parsed.keyword,
        value: parsed.value,
        lineNumber
      };
    })
  };
}
function ndjsonStdoutEmit(event) {
  process.stdout.write(`${JSON.stringify(event)}
`);
}
function noopEmit(_event) {
}
function stderrEmit(event) {
  const type = typeof event.type === "string" ? event.type : "";
  const message = typeof event.message === "string" ? event.message : "";
  if (type === "build_log") {
    const stream = typeof event.stream === "string" ? event.stream : "stdout";
    process.stderr.write(`[${stream}] ${message}
`);
  } else if (message) {
    process.stderr.write(`[${type}] ${message}
`);
  }
}
function debugEnabled() {
  return ["1", "true", "yes", "on"].includes(
    (process.env.TENSORLAKE_DEBUG ?? "").toLowerCase()
  );
}
function buildContextFromEnv() {
  return {
    apiUrl: process.env.TENSORLAKE_API_URL ?? "https://api.tensorlake.ai",
    apiKey: process.env.TENSORLAKE_API_KEY,
    personalAccessToken: process.env.TENSORLAKE_PAT,
    namespace: process.env.INDEXIFY_NAMESPACE ?? "default",
    organizationId: process.env.TENSORLAKE_ORGANIZATION_ID,
    projectId: process.env.TENSORLAKE_PROJECT_ID,
    debug: debugEnabled()
  };
}
function createDefaultClient(context) {
  return new SandboxClient({
    apiUrl: context.apiUrl,
    apiKey: context.apiKey ?? context.personalAccessToken,
    organizationId: context.organizationId,
    projectId: context.projectId,
    namespace: context.namespace
  });
}
async function runChecked(sandbox, command, args, env, workingDir) {
  const result = await sandbox.run(command, {
    args,
    env,
    workingDir
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Command '${command} ${args.join(" ")}' failed with exit code ${result.exitCode}`
    );
  }
  return result;
}
async function runStreaming(sandbox, emit, sleep3, command, args = [], env, workingDir) {
  const proc = await sandbox.startProcess(command, {
    args,
    env,
    workingDir
  });
  let stdoutSeen = 0;
  let stderrSeen = 0;
  let info;
  while (true) {
    const stdoutResp = await sandbox.getStdout(proc.pid);
    emitOutputLines(emit, "stdout", stdoutResp, stdoutSeen);
    stdoutSeen = stdoutResp.lines.length;
    const stderrResp = await sandbox.getStderr(proc.pid);
    emitOutputLines(emit, "stderr", stderrResp, stderrSeen);
    stderrSeen = stderrResp.lines.length;
    info = await sandbox.getProcess(proc.pid);
    if (info.status !== "running" /* RUNNING */) {
      const finalStdout = await sandbox.getStdout(proc.pid);
      emitOutputLines(emit, "stdout", finalStdout, stdoutSeen);
      stdoutSeen = finalStdout.lines.length;
      const finalStderr = await sandbox.getStderr(proc.pid);
      emitOutputLines(emit, "stderr", finalStderr, stderrSeen);
      break;
    }
    await sleep3(300);
  }
  for (let i = 0; i < 10; i++) {
    if (info.exitCode != null || info.signal != null) {
      break;
    }
    await sleep3(200);
    info = await sandbox.getProcess(proc.pid);
  }
  const exitCode = info.exitCode != null ? info.exitCode : info.signal != null ? -info.signal : 0;
  if (exitCode !== 0) {
    throw new Error(
      `Command '${command} ${args.join(" ")}' failed with exit code ${exitCode}`
    );
  }
}
function emitOutputLines(emit, stream, response, seen) {
  for (const line of response.lines.slice(seen)) {
    emit({ type: "build_log", stream, message: line });
  }
}
function isPathWithinContext(contextDir, localPath) {
  const relative = path.relative(contextDir, localPath);
  return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function resolveContextSourcePath(contextDir, source) {
  const resolvedContextDir = path.resolve(contextDir);
  const resolvedSource = path.resolve(resolvedContextDir, source);
  if (!isPathWithinContext(resolvedContextDir, resolvedSource)) {
    throw new Error(`Local path escapes the build context: ${source}`);
  }
  return resolvedSource;
}
async function copyLocalPathToSandbox(sandbox, localPath, remotePath) {
  const fileStats = await stat(localPath).catch(() => null);
  if (!fileStats) {
    throw new Error(`Local path not found: ${localPath}`);
  }
  if (fileStats.isFile()) {
    await runChecked(sandbox, "mkdir", ["-p", path.posix.dirname(remotePath)]);
    await sandbox.writeFile(remotePath, await readFile(localPath));
    return;
  }
  if (!fileStats.isDirectory()) {
    throw new Error(`Local path not found: ${localPath}`);
  }
  const entries = await readdir(localPath, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(localPath, entry.name);
    const destinationPath = path.posix.join(remotePath, entry.name);
    if (entry.isDirectory()) {
      await runChecked(sandbox, "mkdir", ["-p", destinationPath]);
      await copyLocalPathToSandbox(sandbox, sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await runChecked(
        sandbox,
        "mkdir",
        ["-p", path.posix.dirname(destinationPath)]
      );
      await sandbox.writeFile(destinationPath, await readFile(sourcePath));
    }
  }
}
async function persistEnvVar(sandbox, processEnv, key, value) {
  const exportLine = `export ${key}=${shellQuote(value)}`;
  await runChecked(
    sandbox,
    "sh",
    ["-c", `printf '%s\\n' ${shellQuote(exportLine)} >> /etc/environment`],
    processEnv
  );
}
async function copyFromContext(sandbox, emit, contextDir, sources, destination, workingDir, keyword) {
  const destinationPath = resolveContainerPath(destination, workingDir);
  if (sources.length > 1 && !destinationPath.endsWith("/")) {
    throw new Error(
      `${keyword} with multiple sources requires a directory destination ending in '/'`
    );
  }
  for (const source of sources) {
    const localSource = resolveContextSourcePath(contextDir, source);
    const localStats = await stat(localSource).catch(() => null);
    if (!localStats) {
      throw new Error(`Local path not found: ${localSource}`);
    }
    let remoteDestination = destinationPath;
    if (sources.length > 1) {
      remoteDestination = path.posix.join(
        destinationPath.replace(/\/$/, ""),
        path.posix.basename(source.replace(/\/$/, ""))
      );
    } else if (localStats.isFile() && destinationPath.endsWith("/")) {
      remoteDestination = path.posix.join(
        destinationPath.replace(/\/$/, ""),
        path.basename(source)
      );
    }
    emit({
      type: "status",
      message: `${keyword} ${source} -> ${remoteDestination}`
    });
    await copyLocalPathToSandbox(sandbox, localSource, remoteDestination);
  }
}
async function addUrlToSandbox(sandbox, emit, url, destination, workingDir, processEnv, sleep3) {
  let destinationPath = resolveContainerPath(destination, workingDir);
  const parsedUrl = new URL(url);
  const fileName = path.posix.basename(parsedUrl.pathname.replace(/\/$/, "")) || "downloaded";
  if (destinationPath.endsWith("/")) {
    destinationPath = path.posix.join(destinationPath.replace(/\/$/, ""), fileName);
  }
  const parentDir = path.posix.dirname(destinationPath) || "/";
  emit({
    type: "status",
    message: `ADD ${url} -> ${destinationPath}`
  });
  await runChecked(sandbox, "mkdir", ["-p", parentDir], processEnv);
  await runStreaming(
    sandbox,
    emit,
    sleep3,
    "sh",
    [
      "-c",
      `curl -fsSL --location ${shellQuote(url)} -o ${shellQuote(destinationPath)}`
    ],
    processEnv,
    workingDir
  );
}
async function executeDockerfilePlan(sandbox, plan, emit, sleep3) {
  const processEnv = { ...BUILD_SANDBOX_PIP_ENV };
  let workingDir = "/";
  for (const instruction of plan.instructions) {
    const { keyword, value, lineNumber } = instruction;
    if (keyword === "RUN") {
      emit({ type: "status", message: `RUN ${value}` });
      await runStreaming(
        sandbox,
        emit,
        sleep3,
        "sh",
        ["-c", value],
        processEnv,
        workingDir
      );
      continue;
    }
    if (keyword === "WORKDIR") {
      const tokens = shellSplit(value);
      if (tokens.length !== 1) {
        throw new Error(`line ${lineNumber}: WORKDIR must include exactly one path`);
      }
      workingDir = resolveContainerPath(tokens[0], workingDir);
      emit({ type: "status", message: `WORKDIR ${workingDir}` });
      await runChecked(sandbox, "mkdir", ["-p", workingDir], processEnv);
      continue;
    }
    if (keyword === "ENV") {
      for (const [key, envValue] of parseEnvPairs(value, lineNumber)) {
        emit({ type: "status", message: `ENV ${key}=${envValue}` });
        processEnv[key] = envValue;
        await persistEnvVar(sandbox, processEnv, key, envValue);
      }
      continue;
    }
    if (keyword === "COPY") {
      const { sources, destination } = parseCopyLikeValues(
        value,
        lineNumber,
        keyword
      );
      await copyFromContext(
        sandbox,
        emit,
        plan.contextDir,
        sources,
        destination,
        workingDir,
        keyword
      );
      continue;
    }
    if (keyword === "ADD") {
      const { sources, destination } = parseCopyLikeValues(
        value,
        lineNumber,
        keyword
      );
      if (sources.length === 1 && /^https?:\/\//.test(sources[0])) {
        await addUrlToSandbox(
          sandbox,
          emit,
          sources[0],
          destination,
          workingDir,
          processEnv,
          sleep3
        );
      } else {
        await copyFromContext(
          sandbox,
          emit,
          plan.contextDir,
          sources,
          destination,
          workingDir,
          keyword
        );
      }
      continue;
    }
    if (IGNORED_DOCKERFILE_INSTRUCTIONS.has(keyword)) {
      emit({
        type: "warning",
        message: `Skipping Dockerfile instruction '${keyword}' during snapshot materialization. It is still preserved in the registered Dockerfile.`
      });
      continue;
    }
    throw new Error(
      `line ${lineNumber}: Dockerfile instruction '${keyword}' is not supported for sandbox image creation`
    );
  }
}
async function registerImage(context, name, dockerfile, snapshotId, snapshotUri, isPublic) {
  if (!context.organizationId || !context.projectId) {
    throw new Error(
      "Organization ID and Project ID are required. Run 'tl login' and 'tl init'."
    );
  }
  const bearerToken = context.apiKey ?? context.personalAccessToken;
  if (!bearerToken) {
    throw new Error("Missing TENSORLAKE_API_KEY or TENSORLAKE_PAT.");
  }
  const baseUrl = context.apiUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/platform/v1/organizations/${encodeURIComponent(context.organizationId)}/projects/${encodeURIComponent(context.projectId)}/sandbox-templates`;
  const headers = {
    Authorization: `Bearer ${bearerToken}`,
    "Content-Type": "application/json"
  };
  if (context.personalAccessToken && !context.apiKey) {
    headers["X-Forwarded-Organization-Id"] = context.organizationId;
    headers["X-Forwarded-Project-Id"] = context.projectId;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      dockerfile,
      snapshotId,
      snapshotUri,
      isPublic
    })
  });
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${await response.text()}`
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}
async function createSandboxImage(source, options = {}, deps = {}) {
  const emit = deps.emit ?? (options.verbose ? stderrEmit : noopEmit);
  const sleep3 = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const context = buildContextFromEnv();
  const clientFactory = deps.createClient ?? createDefaultClient;
  const register = deps.registerImage ?? ((...args) => registerImage(...args));
  const sourceLabel = typeof source === "string" ? source : `Image(${source.name})`;
  emit({ type: "status", message: `Loading ${sourceLabel}...` });
  const plan = typeof source === "string" ? await loadDockerfilePlan(source, options.registeredName) : loadImagePlan(source, options);
  emit({
    type: "status",
    message: plan.baseImage == null ? "Starting build sandbox with the default server image..." : `Starting build sandbox from ${plan.baseImage}...`
  });
  const client = clientFactory(context);
  let sandbox;
  try {
    sandbox = await client.createAndConnect({
      ...plan.baseImage == null ? {} : { image: plan.baseImage },
      cpus: options.cpus ?? 2,
      memoryMb: options.memoryMb ?? 4096
    });
    emit({
      type: "status",
      message: `Materializing image in sandbox ${sandbox.sandboxId}...`
    });
    await executeDockerfilePlan(sandbox, plan, emit, sleep3);
    emit({ type: "status", message: "Creating snapshot..." });
    const snapshot = await client.snapshotAndWait(sandbox.sandboxId, {
      contentMode: "filesystem_only"
    });
    emit({
      type: "snapshot_created",
      snapshot_id: snapshot.snapshotId,
      snapshot_uri: snapshot.snapshotUri ?? null
    });
    if (!snapshot.snapshotUri) {
      throw new Error(
        `Snapshot ${snapshot.snapshotId} is missing snapshotUri and cannot be registered as a sandbox image.`
      );
    }
    emit({
      type: "status",
      message: `Registering image '${plan.registeredName}'...`
    });
    const result = await register(
      context,
      plan.registeredName,
      plan.dockerfileText,
      snapshot.snapshotId,
      snapshot.snapshotUri,
      options.isPublic ?? false
    );
    emit({
      type: "image_registered",
      name: plan.registeredName,
      image_id: typeof result.id === "string" && result.id || typeof result.templateId === "string" && result.templateId || ""
    });
    emit({ type: "done" });
    return result;
  } finally {
    if (sandbox) {
      try {
        await sandbox.terminate();
      } catch {
      }
    }
    client.close();
  }
}
async function runCreateSandboxImageCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string", short: "n" },
      cpus: { type: "string" },
      memory: { type: "string" },
      public: { type: "boolean", default: false }
    }
  });
  const dockerfilePath = parsed.positionals[0];
  if (!dockerfilePath) {
    throw new Error("Usage: tensorlake-create-sandbox-image <dockerfile_path> [--name NAME] [--cpus N] [--memory MB] [--public]");
  }
  const cpus = parsed.values.cpus != null ? Number(parsed.values.cpus) : void 0;
  const memoryMb = parsed.values.memory != null ? Number(parsed.values.memory) : void 0;
  if (cpus != null && !Number.isFinite(cpus)) {
    throw new Error(`Invalid --cpus value: ${parsed.values.cpus}`);
  }
  if (memoryMb != null && !Number.isInteger(memoryMb)) {
    throw new Error(`Invalid --memory value: ${parsed.values.memory}`);
  }
  await createSandboxImage(
    dockerfilePath,
    {
      registeredName: parsed.values.name,
      cpus,
      memoryMb,
      isPublic: parsed.values.public
    },
    { emit: ndjsonStdoutEmit }
  );
}
var BUILD_SANDBOX_PIP_ENV, IGNORED_DOCKERFILE_INSTRUCTIONS, UNSUPPORTED_DOCKERFILE_INSTRUCTIONS;
var init_sandbox_image = __esm({
  "src/sandbox-image.ts"() {
    "use strict";
    init_models();
    init_client();
    init_image();
    BUILD_SANDBOX_PIP_ENV = { PIP_BREAK_SYSTEM_PACKAGES: "1" };
    IGNORED_DOCKERFILE_INSTRUCTIONS = /* @__PURE__ */ new Set([
      "CMD",
      "ENTRYPOINT",
      "EXPOSE",
      "HEALTHCHECK",
      "LABEL",
      "STOPSIGNAL",
      "VOLUME"
    ]);
    UNSUPPORTED_DOCKERFILE_INSTRUCTIONS = /* @__PURE__ */ new Set([
      "ARG",
      "ONBUILD",
      "SHELL",
      "USER"
    ]);
  }
});

// src/index.ts
init_client();
init_sandbox();
init_sandbox();
init_desktop();
init_tunnel();

// src/cloud-client.ts
init_defaults();
init_http();
init_models();
init_sse();
var CloudClient = class _CloudClient {
  http;
  organizationId;
  projectId;
  namespace;
  constructor(options) {
    this.organizationId = options?.organizationId;
    this.projectId = options?.projectId;
    this.namespace = options?.namespace ?? NAMESPACE;
    this.http = new HttpClient({
      baseUrl: options?.apiUrl ?? API_URL,
      apiKey: options?.apiKey ?? API_KEY,
      organizationId: this.organizationId,
      projectId: this.projectId,
      maxRetries: options?.maxRetries ?? MAX_RETRIES,
      retryBackoffMs: options?.retryBackoffMs ?? RETRY_BACKOFF_MS
    });
  }
  static forCloud(options) {
    return new _CloudClient(options);
  }
  close() {
    this.http.close();
  }
  async upsertApplication(manifest, codeZip, upgradeRunningRequests = false) {
    const form = new FormData();
    form.append(
      "code",
      new Blob([toBlobPart(codeZip)], { type: "application/zip" }),
      "code.zip"
    );
    form.append("code_content_type", "application/zip");
    form.append("application", JSON.stringify(manifest));
    form.append(
      "upgrade_requests_to_latest_code",
      String(upgradeRunningRequests)
    );
    await this.http.requestResponse("POST", this.namespacePath("applications"), {
      body: form
    });
  }
  async deleteApplication(applicationName) {
    await this.http.requestResponse(
      "DELETE",
      this.namespacePath(`applications/${encodeURIComponent(applicationName)}`)
    );
  }
  async applications() {
    const raw = await this.http.requestJson(
      "GET",
      this.namespacePath("applications")
    );
    return (raw.applications ?? []).map(
      (application) => fromSnakeKeys(application)
    );
  }
  async applicationManifest(applicationName) {
    const raw = await this.http.requestJson(
      "GET",
      this.namespacePath(`applications/${encodeURIComponent(applicationName)}`)
    );
    return fromSnakeKeys(raw);
  }
  async runRequest(applicationName, inputs = []) {
    const path2 = this.namespacePath(
      `applications/${encodeURIComponent(applicationName)}`
    );
    const response = inputs.length === 0 ? await this.http.requestResponse("POST", path2, {
      body: new Uint8Array(),
      headers: { Accept: "application/json" }
    }) : inputs.length === 1 && inputs[0].name === "0" ? await this.http.requestResponse("POST", path2, {
      body: toRequestBody(inputs[0].data),
      headers: {
        Accept: "application/json",
        "Content-Type": inputs[0].contentType
      }
    }) : await this.runMultipartRequest(path2, inputs);
    const body = await parseJsonResponse(response);
    const requestId = body?.request_id;
    if (!requestId) {
      throw new Error("missing request_id in run request response body");
    }
    return requestId;
  }
  async waitOnRequestCompletion(applicationName, requestId) {
    const stream = await this.http.requestStream(
      "GET",
      this.namespacePath(
        `applications/${encodeURIComponent(applicationName)}/requests/${encodeURIComponent(requestId)}/progress`
      )
    );
    for await (const event of parseSSEStream(stream)) {
      if (Object.prototype.hasOwnProperty.call(event, "RequestFinished")) {
        return;
      }
    }
    throw new Error("progress stream ended before request completion");
  }
  async requestMetadata(applicationName, requestId) {
    const raw = await this.http.requestJson(
      "GET",
      this.namespacePath(
        `applications/${encodeURIComponent(applicationName)}/requests/${encodeURIComponent(requestId)}`
      )
    );
    return fromSnakeKeys(raw);
  }
  async requestOutput(applicationName, requestId) {
    const response = await this.http.requestResponse(
      "GET",
      this.namespacePath(
        `applications/${encodeURIComponent(applicationName)}/requests/${encodeURIComponent(requestId)}/output`
      )
    );
    const serializedValue = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    return {
      serializedValue,
      contentType
    };
  }
  async introspectApiKey() {
    const raw = await this.http.requestJson(
      "POST",
      "/platform/v1/keys/introspect"
    );
    return fromSnakeKeys(raw);
  }
  async listSecrets(options) {
    const scope = this.resolveScope(options?.organizationId, options?.projectId);
    const raw = await this.http.requestJson(
      "GET",
      `/platform/v1/organizations/${encodeURIComponent(scope.organizationId)}/projects/${encodeURIComponent(scope.projectId)}/secrets?pageSize=${options?.pageSize ?? 100}`
    );
    return fromSnakeKeys(raw);
  }
  async getSecret(secretId, options) {
    const scope = this.resolveScope(options?.organizationId, options?.projectId);
    const raw = await this.http.requestJson(
      "GET",
      `/platform/v1/organizations/${encodeURIComponent(scope.organizationId)}/projects/${encodeURIComponent(scope.projectId)}/secrets/${encodeURIComponent(secretId)}`
    );
    return fromSnakeKeys(raw);
  }
  async upsertSecrets(secrets, options) {
    const scope = this.resolveScope(options?.organizationId, options?.projectId);
    const raw = await this.http.requestJson(
      "PUT",
      `/platform/v1/organizations/${encodeURIComponent(scope.organizationId)}/projects/${encodeURIComponent(scope.projectId)}/secrets`,
      { body: secrets }
    );
    if (Array.isArray(raw)) {
      return raw.map((secret) => fromSnakeKeys(secret));
    }
    return fromSnakeKeys(raw);
  }
  async deleteSecret(secretId, options) {
    const scope = this.resolveScope(options?.organizationId, options?.projectId);
    await this.http.requestResponse(
      "DELETE",
      `/platform/v1/organizations/${encodeURIComponent(scope.organizationId)}/projects/${encodeURIComponent(scope.projectId)}/secrets/${encodeURIComponent(secretId)}`
    );
  }
  async startImageBuild(buildServicePath, request) {
    const form = new FormData();
    form.append("graph_name", request.applicationName);
    form.append("graph_version", request.applicationVersion);
    form.append("graph_function_name", request.functionName);
    form.append("image_name", request.imageName);
    form.append("image_id", request.imageId);
    form.append(
      "context",
      new Blob([toBlobPart(request.buildContext)]),
      "context.tar.gz"
    );
    const response = await this.http.requestResponse(
      "PUT",
      `${trimTrailingSlashes2(buildServicePath)}/builds`,
      { body: form }
    );
    const raw = await parseJsonResponse(response);
    return fromSnakeKeys(raw);
  }
  async createApplicationBuild(buildServicePath, request, imageContexts) {
    const form = createApplicationBuildForm(request, imageContexts);
    const response = await this.http.requestResponse(
      "POST",
      trimTrailingSlashes2(buildServicePath),
      { body: form }
    );
    const raw = await parseJsonResponse(response);
    return fromSnakeKeys(raw);
  }
  async applicationBuildInfo(buildServicePath, applicationBuildId) {
    const raw = await this.http.requestJson(
      "GET",
      `${trimTrailingSlashes2(buildServicePath)}/${encodeURIComponent(applicationBuildId)}`
    );
    return fromSnakeKeys(raw);
  }
  async cancelApplicationBuild(buildServicePath, applicationBuildId) {
    const raw = await this.http.requestJson(
      "POST",
      `${trimTrailingSlashes2(buildServicePath)}/${encodeURIComponent(applicationBuildId)}/cancel`
    );
    return fromSnakeKeys(raw);
  }
  async buildInfo(buildServicePath, buildId) {
    const raw = await this.http.requestJson(
      "GET",
      `${trimTrailingSlashes2(buildServicePath)}/builds/${encodeURIComponent(buildId)}`
    );
    return fromSnakeKeys(raw);
  }
  async cancelBuild(buildServicePath, buildId) {
    await this.http.requestResponse(
      "POST",
      `${trimTrailingSlashes2(buildServicePath)}/builds/${encodeURIComponent(buildId)}/cancel`
    );
  }
  async *streamBuildLogs(buildServicePath, buildId, signal) {
    const stream = await this.http.requestStream(
      "GET",
      `${trimTrailingSlashes2(buildServicePath)}/builds/${encodeURIComponent(buildId)}/logs`,
      { signal }
    );
    for await (const event of parseSSEStream(stream, signal)) {
      yield fromSnakeKeys(event);
    }
  }
  async runMultipartRequest(path2, inputs) {
    const form = new FormData();
    for (const input of inputs) {
      form.append(
        input.name,
        new Blob([toBlobPart(input.data)], { type: input.contentType }),
        input.name
      );
    }
    return this.http.requestResponse("POST", path2, {
      body: form,
      headers: { Accept: "application/json" }
    });
  }
  namespacePath(subpath) {
    return `/v1/namespaces/${encodeURIComponent(this.namespace)}/${subpath.replace(/^\/+/, "")}`;
  }
  resolveScope(organizationId, projectId) {
    const resolvedOrganizationId = organizationId ?? this.organizationId;
    const resolvedProjectId = projectId ?? this.projectId;
    if (!resolvedOrganizationId || !resolvedProjectId) {
      throw new Error(
        "organizationId and projectId are required for this operation"
      );
    }
    return {
      organizationId: resolvedOrganizationId,
      projectId: resolvedProjectId
    };
  }
};
function createApplicationBuildForm(request, imageContexts) {
  const contextsByPartName = /* @__PURE__ */ new Map();
  for (const context of imageContexts) {
    if (contextsByPartName.has(context.contextTarPartName)) {
      throw new Error(
        `duplicate image context part name '${context.contextTarPartName}'`
      );
    }
    contextsByPartName.set(context.contextTarPartName, context);
  }
  const form = new FormData();
  form.append(
    "app_version",
    new Blob([JSON.stringify(request)], { type: "application/json" }),
    "app_version"
  );
  for (const image of request.images) {
    const context = contextsByPartName.get(image.contextTarPartName);
    if (!context) {
      throw new Error(
        `missing image context for part '${image.contextTarPartName}'`
      );
    }
    form.append(
      image.contextTarPartName,
      new Blob([toBlobPart(context.contextTarGz)]),
      `${image.contextTarPartName}.tar.gz`
    );
  }
  for (const context of imageContexts) {
    if (!request.images.some((image) => image.contextTarPartName === context.contextTarPartName)) {
      throw new Error(
        `unexpected image context for part '${context.contextTarPartName}'`
      );
    }
  }
  return form;
}
function trimTrailingSlashes2(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
function toBlobPart(data) {
  if (typeof data === "string" || data instanceof Blob) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Uint8Array.from(data).buffer;
  }
  return data;
}
function toRequestBody(data) {
  return toBlobPart(data);
}
async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return void 0;
  }
  return JSON.parse(text);
}

// src/api-client.ts
init_errors();
var APIClient = class {
  cloudClient;
  constructor(options) {
    this.cloudClient = new CloudClient(options);
  }
  close() {
    this.cloudClient.close();
  }
  async upsertApplication(manifest, codeZip, upgradeRunningRequests = false) {
    await this.cloudClient.upsertApplication(
      manifest,
      codeZip,
      upgradeRunningRequests
    );
  }
  async deleteApplication(applicationName) {
    await this.cloudClient.deleteApplication(applicationName);
  }
  async applications() {
    return this.cloudClient.applications();
  }
  async application(applicationName) {
    return this.cloudClient.applicationManifest(applicationName);
  }
  async runRequest(applicationName, inputs) {
    return this.cloudClient.runRequest(applicationName, inputs);
  }
  async waitOnRequestCompletion(applicationName, requestId) {
    await this.cloudClient.waitOnRequestCompletion(applicationName, requestId);
  }
  async requestOutput(applicationName, requestId) {
    const metadata = await this.cloudClient.requestMetadata(
      applicationName,
      requestId
    );
    if (metadata.outcome == null) {
      throw new RequestNotFinishedError();
    }
    if (typeof metadata.outcome === "object") {
      if (metadata.requestError?.message) {
        throw new RequestExecutionError(
          metadata.requestError.message,
          metadata.requestError.functionName
        );
      }
      const failure = typeof metadata.outcome.failure === "string" ? metadata.outcome.failure : JSON.stringify(metadata.outcome);
      throw new RequestFailedError(failure);
    }
    return this.cloudClient.requestOutput(applicationName, requestId);
  }
};

// src/index.ts
init_sandbox_image();
init_image();
init_errors();
init_models();
export {
  APIClient,
  CloudClient,
  ContainerState,
  Desktop,
  Image,
  ImageBuildOperationType,
  OutputMode,
  PoolInUseError,
  PoolNotFoundError,
  ProcessStatus,
  Pty,
  RemoteAPIError,
  RequestExecutionError,
  RequestFailedError,
  RequestNotFinishedError,
  Sandbox,
  SandboxClient,
  SandboxConnectionError,
  SandboxError,
  SandboxException,
  SandboxNotFoundError,
  SandboxStatus,
  SnapshotStatus,
  StdinMode,
  TcpTunnel,
  createSandboxImage,
  dockerfileContent
};
//# sourceMappingURL=index.js.map