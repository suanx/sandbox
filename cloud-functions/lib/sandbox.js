// ============================================================================
// Tensorlake 沙盒层 —— 一个任务一个沙盒，任务结束必销毁
//
// 省钱纪律：
//   1) RAM / disk 按【分配量】全程计费 → 任务结束（或超时）必须 terminate
//   2) 沙盒在 LLM 思考期间是空转的 → 上层已把「第一轮」的 LLM 调用前置到
//      建沙盒之前，省掉一次思考时间的开销
//   3) ephemeral（不传 name）→ 不会 suspend 留存，零存储费
// ============================================================================

const DEFAULTS = { cpus: 1, memoryMb: 1024, diskMb: 10240, timeoutSecs: 300 };

export async function create(env) {
  const mod = await import('tensorlake');
  const Sandbox = mod.Sandbox ?? mod.default?.Sandbox ?? mod.default;
  if (!Sandbox) throw new Error('tensorlake: 未找到 Sandbox 导出，请检查 SDK 版本');

  const apiKey = env.TENSORLAKE_API_KEY;
  if (!apiKey) throw new Error('TENSORLAKE_API_KEY 未配置');

  return await Sandbox.create({
    apiKey,
    cpus: Number(env.TL_CPUS || DEFAULTS.cpus),
    memoryMb: Number(env.TL_MEMORY_MB || DEFAULTS.memoryMb),
    diskMb: Number(env.TL_DISK_MB || DEFAULTS.diskMb),
    timeoutSecs: Number(env.TL_TIMEOUT_SECS || DEFAULTS.timeoutSecs),
    ...(env.TL_IMAGE ? { image: env.TL_IMAGE } : {}),
  });
}

/**
 * 执行一条命令，返回 stdout+stderr 合并文本（失败也返回，交给 LLM 自己修）。
 * timeoutMs > 0 时加单命令等待上限：只放弃【等待】，不杀死沙盒内进程——
 * 防止挂死命令（sleep 1000 / 等 stdin）把整个请求拖穿预算。
 */
export async function exec(sb, cmd, timeoutMs = 0) {
  const run = async () => {
    try {
      if (typeof sb.run === 'function') {
        const r = await sb.run(cmd);
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
      try { await sb[fn](); return; } catch (e) { console.error(`[sandbox] ${fn}() 失败: ${e?.message ?? e}`); }
    }
  }
  console.error('[sandbox] 首轮销毁全部失败，3s 后重试一轮');
  await new Promise(r => setTimeout(r, 3000));
  for (const fn of DESTROY_FNS) {
    if (typeof sb[fn] === 'function') {
      try { await sb[fn](); console.log('[sandbox] 重试销毁成功'); return; } catch { /* 继续下一个 */ }
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
