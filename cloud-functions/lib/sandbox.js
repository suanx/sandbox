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
//   connect(sandboxId) 附着已有沙盒 → 环境与文件延续 → 用完保持 running
//   （2026-10-19 用户约束「不要快照/不要花钱」），寿命由
//   SESSION_TIMEOUT_SECS（默认 2h）封顶由平台自动回收；服务端零状态，
//   无 KV、无 name 留存。
//
// 镜像策略（2026-10-19 用户约束「没法充值 + 启动要快，工具到时候再装」）：
//   平台默认镜像（已注册、秒级可用），不预装任何东西——LLM 在任务里按需
//   apt 现装（进度对其可见），随沙盒 2h 生命周期归零。TL_IMAGE 可覆盖。
// ============================================================================

const DEFAULTS = { cpus: 1, memoryMb: 1024, diskMb: 10240, timeoutSecs: 300 };

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

function imageOpts(env, timeoutSecs) {
  // TL_IMAGE 可显式指向某个已注册模板名（运维选项）；默认不传 = 平台默认镜像
  const image = String(env.TL_IMAGE || '').trim();
  return {
    apiKey: env.TENSORLAKE_API_KEY,
    cpus: Number(env.TL_CPUS || DEFAULTS.cpus),
    memoryMb: Number(env.TL_MEMORY_MB || DEFAULTS.memoryMb),
    diskMb: Number(env.TL_DISK_MB || DEFAULTS.diskMb),
    timeoutSecs,
    ...(image ? { image } : {}),
  };
}

export async function create(env) {
  const Sandbox = await _loadSdk();
  if (!env.TENSORLAKE_API_KEY) throw new Error('TENSORLAKE_API_KEY 未配置');
  return await withTimeout(Sandbox.create(imageOpts(env, Number(env.TL_TIMEOUT_SECS || DEFAULTS.timeoutSecs))), '创建沙盒');
}

/**
 * 会话模式：新建一个长寿命沙盒（timeoutSecs 独立配置，默认 2h 封顶）。
 * 返回的句柄带 sandboxId，调用方须把它交回客户端作下次复用凭据。
 */
export async function createSession(env) {
  const Sandbox = await _loadSdk();
  if (!env.TENSORLAKE_API_KEY) throw new Error('TENSORLAKE_API_KEY 未配置');
  const timeoutSecs = Number(env.SESSION_TIMEOUT_SECS || 7200);
  return await withTimeout(Sandbox.create(imageOpts(env, timeoutSecs)), '创建会话沙盒');
}

/**
 * 会话模式：按客户端持有的 sandboxId 附着已有沙盒。
 * 成功 → 返回句柄（调用方负责后续 exec）；不存在/已回收 → 抛错由上层新建兜底。
 */
export async function connect(env, sandboxId) {
  const Sandbox = await _loadSdk();
  if (!env.TENSORLAKE_API_KEY) throw new Error('TENSORLAKE_API_KEY 未配置');
  return await withTimeout(Sandbox.connect({ apiKey: env.TENSORLAKE_API_KEY, sandboxId: String(sandboxId) }), '接回会话沙盒');
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
  if (!env.TENSORLAKE_API_KEY) throw new Error('TENSORLAKE_API_KEY 未配置');
  const client = new SandboxClient({ apiKey: env.TENSORLAKE_API_KEY }, true);
  return await withTimeout(client.list(), '列出沙盒');
}

/** 按 id 直接删除沙盒（走平台 DELETE，无需 connect 建隧道，轻量）。 */
export async function destroyById(env, sandboxId) {
  const mod = await import('./tensorlake-0.5.0-patched.mjs');
  const SandboxClient = mod.SandboxClient;
  if (!SandboxClient) throw new Error('tensorlake: 未找到 SandboxClient 导出');
  if (!env.TENSORLAKE_API_KEY) throw new Error('TENSORLAKE_API_KEY 未配置');
  const client = new SandboxClient({ apiKey: env.TENSORLAKE_API_KEY }, true);
  await withTimeout(client.delete(String(sandboxId)), '删除沙盒');
}

// 会话/任务的标准工作目录（镜像用户 tl-user 的家目录下，可写）。
// / 与 /workspace 均不可写（2026-10-19 实测），exec 统一在此目录执行，
// LLM 的相对路径文件操作因此直接可用。
//
// （2026-10-20 优化）原独立 initWorkdir() 一次 exec 往返（~0.5-2s）已取消：
// exec 现在在 shell 命令行内 `mkdir -p <dir> && cd <dir>` 前置保证工作目录
// ——mkdir 幂等且本地瞬时（同一 shell 调用，无额外往返），目录已存在时
// 零开销，且不再依赖 SDK working_dir 参数（该参数在目录缺失时进程直接
// 启动失败）。
export const WORKDIR = '/home/tl-user/workspace';

/**
 * 清理孤儿沙盒：销毁命名空间内沙盒，返回销毁成功的 id 列表。
 *
 * 保护机制（2026-10-20，修复 08:07 误杀活跃会话事故）：
 *   ① protectIds：调用方（中继）下发的「确认活跃」沙盒 id——服务端零状态
 *      本无法区分孤儿与在用会话，但中继侧有任务/事件落库，可把最近活跃的
 *      sandboxId 传进来，清场时跳过；
 *   ② minAgeMs：能从 list() 解析出创建时间时，跳过创建不满 minAgeMs 的
 *      沙盒（大概率刚被某会话接管）；字段缺失时退回旧行为（自建单用户
 *      前提下「现存即孤儿」）。
 */
export async function destroyAll(env, { protectIds = [], minAgeMs = 5 * 60_000 } = {}) {
  const all = await listAll(env);
  const protect = new Set(protectIds.map(String));
  const now = Date.now();
  const killed = [];
  for (const s of all ?? []) {
    if (!s?.sandboxId) continue;
    const sid = String(s.sandboxId);
    if (protect.has(sid)) continue; // 确认活跃：绝不碰
    if (minAgeMs > 0) {
      const created = Number(s.createdAt ?? s.createdAtMs ?? s.created_at ?? 0);
      if (created > 0 && now - created < minAgeMs) continue; // 太新，疑似活跃
    }
    try { await destroyById(env, sid); killed.push(sid); } catch { /* 单个失败不阻断 */ }
  }
  return killed;
}

/**
 * 执行一条命令，返回 stdout+stderr 合并文本（失败也返回，交给 LLM 自己修）。
 * workdir：命令的工作目录（可写目录，见 WORKDIR）。目录在工作目录在 shell
 * 行内 `mkdir -p && cd` 保证（幂等、同一次调用、无额外往返），不再用 SDK
 * 的 working_dir 参数（目录缺失时进程直接启动失败，见 WORKDIR 注释）。
 * timeoutMs > 0 时加单命令等待上限：只放弃【等待】，不杀死沙盒内进程——
 * 防止挂死命令（sleep 1000 / 等 stdin）把整个请求拖穿预算。
 */
export async function exec(sb, cmd, timeoutMs = 0, workdir) {
  const line = workdir
    ? `mkdir -p '${WORKDIR}' && cd '${WORKDIR}' &&\n${cmd}`
    : cmd;
  const opts = { args: ['-lc', line] };
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

// 销毁总预算（2026-10-20）：此前 4 个函数名 × 20s 超时 × 2 轮 + 3s 间隔，
// 最坏 ~163s——超出 EdgeOne 120s 平台上限，且 JSON 模式的 busy 锁要等
// destroy 完成才释放，会拖出连环 429。现在总预算封顶（默认 30s），到点
// 放弃并交给 destroyById 轻量兜底 / 平台按 timeoutSecs 回收。
const DESTROY_BUDGET_MS = 30_000;

/**
 * 销毁沙盒：逐个尝试可用方式（总预算封顶）；全部失败时走 destroyById
 * 轻量 DELETE API 兜底（无需 connect 建隧道）。两路都失败才放弃——沙盒
 * 按 timeoutSecs 由平台回收。
 */
export async function destroy(env, sb) {
  const t0 = Date.now();
  const tryFns = async (label) => {
    for (const fn of DESTROY_FNS) {
      if (typeof sb[fn] !== 'function') continue;
      if (Date.now() - t0 > DESTROY_BUDGET_MS) return false; // 预算耗尽
      try {
        await withTimeout(sb[fn](), `销毁沙盒(${label}/${fn})`);
        return true;
      } catch (e) {
        console.error(`[sandbox] ${fn}() 失败: ${e?.message ?? e}`);
      }
    }
    return false;
  };

  if (await tryFns('首轮')) return;

  // 首轮失败：不再盲试 4 个函数名，直接走 destroyById（按 id DELETE，最准）
  const sid = sb?.sandboxId ? String(sb.sandboxId) : '';
  if (sid && env?.TENSORLAKE_API_KEY) {
    try {
      await withTimeout(destroyById(env, sid), '销毁沙盒(destroyById 兜底)');
      console.log('[sandbox] destroyById 兜底销毁成功');
      return;
    } catch (e) {
      console.error(`[sandbox] destroyById 兜底失败: ${e?.message ?? e}`);
    }
  }

  // 最后重试一轮句柄方法（此时预算大概率已尽，能试多少试多少）
  await tryFns('重试');
  console.error('[sandbox] 销毁彻底失败，沙盒将按 timeoutSecs 兜底回收（可能产生少量费用）');
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
