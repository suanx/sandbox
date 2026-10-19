// ============================================================================
// Tensorlake 沙盒层 —— 一个任务一个沙盒，任务结束必销毁
//
// 省钱纪律：
//   1) RAM / disk 按【分配量】全程计费 → 任务结束（或超时）必须 terminate
//   2) 沙盒在 LLM 思考期间是空转的 → 上层已把「第一轮」的 LLM 调用前置到
//      建沙盒之前，省掉一次思考时间的开销
//   3) ephemeral（不传 name）→ 不会 suspend 留存，零存储费
//
// 会话模式（2026-10-19 方案 A）：客户端持 sandboxId 作为会话令牌——
//   connect(sandboxId) 附着已有沙盒 → resume 恢复（suspend 只收 storage 费，
//   文件系统/已装依赖全保留）→ 用完 suspend 而非 destroy。寿命由
//   SESSION_TIMEOUT_SECS（默认 2h）封顶，到点平台自动回收；服务端零状态，
//   无 KV、无 name 留存。suspend 失败兜底直接 destroy（丢会话不丢钱）。
// ============================================================================

const DEFAULTS = { cpus: 1, memoryMb: 1024, diskMb: 10240, timeoutSecs: 300 };

// 平台 API 单次调用超时（2026-10-19 事故修复）：SDK 的 requestJson 无内置
// 超时——TensorLake API 一旦挂住（网络/平台抖动），整个云函数会被 EdgeOne
// 120s 强杀，客户端拿到被砍断的空流。所有直连调用必须套这层保险。
const TL_API_TIMEOUT_MS = 20_000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${label} 超时（${TL_API_TIMEOUT_MS / 1000}s，TensorLake API 无响应）`)), TL_API_TIMEOUT_MS)),
  ]);
}

async function _loadSdk() {
  // 内嵌 tensorlake@0.5.0（纯 HTTP/SSE 实现，无原生二进制依赖）。
  // 不要换成 npm 上的新版本——0.5.141+ 引入原生二进制绑定
  // （@tensorlakeai/native-*），EdgeOne 云函数无法加载；两处 API 兼容
  // 补丁已打进本文件：①创建请求 ephemeral_disk_mb→disk_mb ②（本文件的
  // exec）整行命令经 /bin/sh -lc 包装。详见 DEPLOY.md。
  const mod = await import('./tensorlake-0.5.0-patched.mjs');
  const Sandbox = mod.Sandbox ?? mod.default?.Sandbox ?? mod.default;
  if (!Sandbox) throw new Error('tensorlake: 未找到 Sandbox 导出，请检查 SDK 版本');
  return Sandbox;
}

export async function create(env) {
  const Sandbox = await _loadSdk();
  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');

  return await withTimeout(Sandbox.create({
    apiKey,
    cpus: Number(env.TL_CPUS || DEFAULTS.cpus),
    memoryMb: Number(env.TL_MEMORY_MB || DEFAULTS.memoryMb),
    diskMb: Number(env.TL_DISK_MB || DEFAULTS.diskMb),
    timeoutSecs: Number(env.TL_TIMEOUT_SECS || DEFAULTS.timeoutSecs),
    ...(env.TL_IMAGE ? { image: env.TL_IMAGE } : {}),
  }), '创建沙盒');
}

/**
 * 会话模式：新建一个长寿命沙盒（timeoutSecs 独立配置，默认 2h 封顶）。
 * 返回的句柄带 sandboxId，调用方须把它交回客户端作下次复用凭据。
 */
export async function createSession(env) {
  const Sandbox = await _loadSdk();
  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');

  const timeoutSecs = Number(env.SESSION_TIMEOUT_SECS || 7200);
  return await withTimeout(Sandbox.create({
    apiKey,
    cpus: Number(env.TL_CPUS || DEFAULTS.cpus),
    memoryMb: Number(env.TL_MEMORY_MB || DEFAULTS.memoryMb),
    diskMb: Number(env.TL_DISK_MB || DEFAULTS.diskMb),
    timeoutSecs,
    ...(env.TL_IMAGE ? { image: env.TL_IMAGE } : {}),
  }), '创建会话沙盒');
}

/**
 * 会话模式：按客户端持有的 sandboxId 附着已有沙盒。
 * 成功 → 返回句柄（调用方负责 resume）；不存在/已回收 → 抛错由上层新建兜底。
 */
export async function connect(env, sandboxId) {
  const Sandbox = await _loadSdk();
  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');
  return await withTimeout(Sandbox.connect({ apiKey, sandboxId: String(sandboxId) }), '接回会话沙盒');
}

/**
 * 列出命名空间内全部沙盒（running/suspended）。
 * 用途：孤儿沙盒清理（Free 层并发 1，App 丢失 sandboxId 后遗留的
 * running 沙盒会占掉唯一并发名额，2h 内无法创建新沙盒）。
 * 返回 [{sandboxId, status, ...}]。
 */
export async function listAll(env) {
  const mod = await import('./tensorlake-0.5.0-patched.mjs');
  const SandboxClient = mod.SandboxClient;
  if (!SandboxClient) throw new Error('tensorlake: 未找到 SandboxClient 导出');
  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');
  const client = new SandboxClient({ apiKey }, true);
  return await withTimeout(client.list(), '列出沙盒');
}

/** 按 id 直接删除沙盒（走平台 DELETE，无需 connect 建隧道，轻量）。 */
export async function destroyById(env, sandboxId) {
  const mod = await import('./tensorlake-0.5.0-patched.mjs');
  const SandboxClient = mod.SandboxClient;
  if (!SandboxClient) throw new Error('tensorlake: 未找到 SandboxClient 导出');
  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');
  const client = new SandboxClient({ apiKey }, true);
  await withTimeout(client.delete(String(sandboxId)), '删除沙盒');
}

// 会话/任务的标准工作目录（镜像用户 tl-user 的家目录下，可写）。
// / 与 /workspace 均不可写（2026-10-19 实测），exec 统一在此目录执行，
// LLM 的相对路径文件操作因此直接可用。
export const WORKDIR = '/home/tl-user/workspace';

/**
 * 初始化沙盒工作目录（幂等，mkdir -p）。会话沙盒在创建/接回后调用一次；
 * 失败仅告警不抛（exec 的 working_dir 缺目录时进程会启动失败，届时错误
 * 会经命令输出回灌 LLM 自行纠正）。
 */
export async function initWorkdir(sb) {
  const out = await exec(sb, `mkdir -p ${WORKDIR}`, 15_000);
  if (String(out).includes('执行异常') || String(out).includes('无法')) {
    console.error(`[sandbox] 工作目录初始化异常: ${out}`);
  }
}

/**
 * 清理孤儿沙盒：销毁命名空间内全部现存沙盒，返回销毁成功的 id 列表。
 * 自建单用户部署的前提下「现存即孤儿」——正在服务中的沙盒不会被走到
 * 这里（客户端持有其 sandboxId，走 connect 复用路径）。
 */
export async function destroyAll(env) {
  const all = await listAll(env);
  const killed = [];
  for (const s of all ?? []) {
    if (!s?.sandboxId) continue;
    try { await destroyById(env, s.sandboxId); killed.push(s.sandboxId); } catch { /* 单个失败不阻断 */ }
  }
  return killed;
}

/**
 * 执行一条命令，返回 stdout+stderr 合并文本（失败也返回，交给 LLM 自己修）。
 * timeoutMs > 0 时加单命令等待上限：只放弃【等待】，不杀死沙盒内进程——
 * 防止挂死命令（sleep 1000 / 等 stdin）把整个请求拖穿预算。
 * workdir：命令的工作目录（可写目录，见 WORKDIR）；不传则用镜像默认（家目录）。
 */
export async function exec(sb, cmd, timeoutMs = 0, workdir) {
  const opts = workdir ? { args: ['-lc', cmd], workingDir: workdir } : { args: ['-lc', cmd] };
  const run = async () => {
    try {
      if (typeof sb.run === 'function') {
        // 现行 API：command 只接受单个可执行文件路径，整行命令须经 shell 解释
        // （官方用法 sbx.run("/bin/sh", { args: ["-c", "..."] })）。
        // spawn 失败（旧语义/无 shell）时回退整行直传。
        let r;
        try {
          r = await sb.run('/bin/sh', opts);
        } catch {
          r = await sb.run(cmd);
        }
        return join(r?.stdout, r?.stderr);
      }
      if (typeof sb.commands?.run === 'function') {
        const r = await sb.commands.run(cmd);
        return join(r?.stdout, r?.stderr);
      }
      if (typeof sb.exec === 'function') {
        const r = await sb.exec(cmd);
        return join(r?.stdout, r?.stderr);
      }
      return `[沙盒不支持执行入口] ${cmd}`;
    } catch (e) {
      return `[执行异常] ${e?.message ?? e}`;
    }
  };

  if (!timeoutMs || timeoutMs <= 0) return run();

  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`命令超过 ${Math.round(timeoutMs / 1000)}s 未返回，已放弃等待`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    // 超时路径：把原因写进输出，LLM 下一轮能看到并换方案
    return `[执行异常] ${e?.message ?? e}`;
  } finally {
    clearTimeout(timer);
  }
}

const DESTROY_FNS = ['terminate', 'kill', 'stop', 'close'];

/** 销毁沙盒：逐个尝试可用方式；全部失败时打日志 + 隔 3s 重试一轮。 */
export async function destroy(sb) {
  for (const fn of DESTROY_FNS) {
    if (typeof sb[fn] === 'function') {
      try { await withTimeout(sb[fn](), `销毁沙盒(${fn})`); return; } catch (e) { console.error(`[sandbox] ${fn}() 失败: ${e?.message ?? e}`); }
    }
  }
  console.error('[sandbox] 首轮销毁全部失败，3s 后重试一轮');
  await new Promise(r => setTimeout(r, 3000));
  for (const fn of DESTROY_FNS) {
    if (typeof sb[fn] === 'function') {
      try { await withTimeout(sb[fn](), `销毁沙盒重试(${fn})`); console.log('[sandbox] 重试销毁成功'); return; } catch { /* 继续下一个 */ }
    }
  }
  console.error('[sandbox] 销毁彻底失败，沙盒将按 TL_TIMEOUT_SECS 兜底回收（可能产生少量费用）');
}

function join(out, err) {
  const o = String(out ?? '').trim();
  const e = String(err ?? '').trim();
  if (o && e) return `${o}\n[stderr] ${e}`;
  return o || e || '(无输出)';
}

/**
 * 挂起会话沙盒（任务间歇，可选：SESSION_SUSPEND=1 时启用）：内存快照落盘，
 * 此后只收 storage 费；下次 connect 后 resume() 恢复文件系统与依赖。
 * 失败不打断主流程（最坏情况：沙盒保持 running 烧到 timeoutSecs 自动回收）。
 */
export async function suspendSafe(sb) {
  if (!sb || typeof sb.suspend !== 'function') return;
  try { await sb.suspend(); } catch (e) {
    console.error(`[sandbox] suspend 失败（沙盒将烧到超时自动回收）: ${e?.message ?? e}`);
  }
}

/** 恢复挂起的会话沙盒；已在 running 态时 resume 报错也无妨（幂等处理）。 */
export async function resumeSafe(sb) {
  if (!sb || typeof sb.resume !== 'function') return;
  try { await sb.resume(); } catch { /* running 态 resume 会报错，忽略 */ }
}
