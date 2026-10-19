// ============================================================================
// AI 自主任务执行器
// POST /api/chat   body: { "task": "用 python 分析..." }
//
// 流程（关键：第一轮 LLM 调用在建沙盒【之前】——省掉一次思考时间的沙盒空转）：
//
//   LLM 决定第一条命令
//        ↓
//   建沙盒 ──→ 执行 ──→ 输出回灌 LLM ──→ 下一条命令 ──→ ... ──→ done
//        ↓
//   任务结束 / 超时 / 出错 → 立刻 terminate（finally 保证）
//
// 无 KV、无会话、无留存：一个任务一次请求，请求结束一切归零。
// ============================================================================

import { decide } from '../lib/llm.js';
import { create, exec, destroy } from '../lib/sandbox.js';

// 单实例内的并发锁：一个人用、一个任务一个沙盒，忙了直接拒绝
let busy = false;

// APP_TOKEN 未配置只警告一次，不改变鉴权行为（保持可选）
let warnedNoToken = false;

// 单命令等待上限（默认 90s，低于 BUDGET_MS 预算；只放弃等待不杀进程）
function cmdTimeoutMs(env) {
  return clamp(Number(env.CMD_TIMEOUT_MS || 90_000), 1_000, 300_000);
}

/** 恒时比较：避免 token 校验的时序侧信道 */
function safeEqual(a, b) {
  const A = String(a ?? ''), B = String(b ?? '');
  const n = Math.max(A.length, B.length);
  let diff = A.length ^ B.length;
  for (let i = 0; i < n; i++) diff |= (A.charCodeAt(i) || 0) ^ (B.charCodeAt(i) || 0);
  return diff === 0;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * orion_agent_cloud 令牌远端校验（2026-10-19 对接）。
 * GET {ORION_BASE_URL}/api/auth/introspect，200 即有效（401 = 令牌无效/过期）。
 * 5s 超时：introspect 挂住时快速失败，不让鉴权环节拖住整个任务。
 */
async function orionIntrospect(env, token) {
  const base = String(env.ORION_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, reason: 'ORION_BASE_URL 未配置' };
  try {
    const res = await fetch(`${base}/api/auth/introspect`, {
      headers: { 'x-orion-token': `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200) {
      const j = await res.json().catch(() => null);
      return { ok: true, userId: String(j?.userId ?? '') };
    }
    return { ok: false, reason: `orion HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, reason: `orion 不可达: ${e?.message ?? e}` };
  }
}

export async function onRequest(context) {
  const req = context.request ?? context;
  const env = context.env ?? {};

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
  if (req.method !== 'POST') return json(env, { error: '仅支持 POST /api/chat' }, 405);

  // ---------- 鉴权 ----------
  // 凭据优先级（2026-10-19 对接 orion_agent_cloud）：
  //   载体：优先读 X-Orion-Token（EdgeOne 会把 Authorization 覆盖成平台 COS
  //   签名，与 orion 侧同款坑），Authorization 作回退。
  //   通道 A：凭据形如 JWT（eyJ 开头）或设备令牌（dt_ 开头）→ 调 orion
  //           /api/auth/introspect 远端校验，200 放行。
  //   通道 B：其余凭据 → 与 APP_TOKEN 恒时比对（独立部署通道，行为不变）。
  //   两者都未配置 → 免鉴权放行（保持原行为），仅警告一次。
  const headerVal =
    req.headers?.get?.('x-orion-token') || req.headers?.get?.('authorization') || '';
  const raw = headerVal.replace(/^Bearer\s+/i, '').trim();
  const token = env.APP_TOKEN;
  const orionBase = String(env.ORION_BASE_URL || '').trim();
  const looksOrion = /^eyJ/.test(raw) || raw.startsWith('dt_');

  if (raw) {
    if (looksOrion) {
      const v = await orionIntrospect(env, raw);
      if (!v.ok) return json(env, { error: `unauthorized (${v.reason})` }, 401);
    } else if (token) {
      if (!safeEqual(raw, token)) return json(env, { error: 'unauthorized' }, 401);
    }
    // 非 orion 形态且未配 APP_TOKEN → 免鉴权放行（保持原行为）
  } else if (token) {
    return json(env, { error: 'unauthorized' }, 401);
  } else if (!warnedNoToken) {
    warnedNoToken = true;
    console.warn('[auth] APP_TOKEN 未配置：接口当前免鉴权，任何人可调用并消耗 Tensorlake/LLM 额度');
  }

  let body = {};
  try { body = await req.json(); } catch { /* 空 body */ }

  // 兼容两种叫法：task（新） / cmd（旧，直接当命令跑）
  const task = String(body.task ?? '').trim();
  const directCmd = String(body.cmd ?? '').trim();
  if (!task && !directCmd) { return json(env, { error: 'task 不能为空' }, 400); }

  if (busy) return json(env, { error: 'busy: 上一个任务还在跑' }, 429);
  busy = true;

  const maxTurns = clamp(Number(env.MAX_TURNS || body.maxTurns || 8), 1, 20);
  const budgetMs = clamp(Number(env.BUDGET_MS || 110_000), 10_000, 600_000);
  const cmdMs = cmdTimeoutMs(env);

  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const turns = [];
  const history = [];
  let sb = null;
  let answer = '';
  let finish = 'done';

  try {
    // ---------- 直接命令模式（不走 LLM，方便调试沙盒） ----------
    if (!task && directCmd) {
      sb = await create(env);
      const out = await exec(sb, directCmd, cmdMs);
      return json(env, {
        answer: out, turns: [{ i: 1, thought: '', command: directCmd, output: out }],
        finish: 'done', ms: Date.now() - t0,
      });
    }

    // ---------- 多轮自主循环 ----------
    for (let i = 1; i <= maxTurns; i++) {
      // 时间预算：到点立刻收尾，绝不让沙盒继续烧钱
      if (Date.now() > deadline) { finish = 'timeout'; break; }

      // ① 问 LLM（第一轮时 sb 还是 null —— 这段时间不烧沙盒钱）
      // 调用失败重试 1 次：网络抖动不再让整个任务报废（预算内自动消化）
      let d = null, lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { d = await decide(env, task, history, { i, max: maxTurns }); lastErr = null; break; }
        catch (e) { lastErr = e; if (attempt < 2 && Date.now() < deadline) await sleep(800); }
      }
      if (lastErr) {
        finish = 'llm_error';
        turns.push({ i, thought: `LLM 调用失败: ${lastErr.message}`, command: '', output: '' });
        break;
      }

      if (d.parseError && Date.now() < deadline) {
        // 输出解析失败也重试 1 次：模型偶发不按 JSON 回，再给一次机会
        try { d = await decide(env, task, history, { i, max: maxTurns }); } catch { /* 保持 parseError */ }
      }
      if (d.parseError) {
        turns.push({ i, thought: '模型输出无法解析，已终止', command: '', output: d.raw || '' });
        finish = 'parse_error';
        break;
      }

      if (d.done || !d.command) {
        answer = d.answer || d.thought || '任务完成';
        finish = 'done';
        break;
      }

      // ② 第一条命令出来了才建沙盒
      try {
        if (!sb) sb = await create(env);
      } catch (e) {
        turns.push({ i, thought: d.thought, command: d.command, output: `沙盒创建失败: ${e.message}` });
        finish = 'sandbox_error';
        break;
      }

      // ③ 执行（带单命令等待上限，防挂死命令拖穿预算）
      const output = await exec(sb, d.command, cmdMs);
      turns.push({ i, thought: d.thought, command: d.command, output });
      history.push({ command: d.command, output });

      // 再检查一次预算，避免执行完已超时还在继续
      if (Date.now() > deadline) { finish = 'timeout'; break; }
    }

    if (!answer) {
      answer = finish === 'timeout'
        ? `已达时间预算（${Math.round(budgetMs / 1000)}s），未完成。已执行 ${turns.length} 步。`
        : finish === 'max_turns'
          ? `已达最大轮数 ${maxTurns}，未完成。`
          : '任务结束，未给出明确结论。';
    }
    if (finish === 'done' && turns.length >= maxTurns) finish = 'max_turns';

    return json(env, { answer, turns, finish, ms: Date.now() - t0 });
  } catch (e) {
    return json(env, {
      answer: '', turns, finish: 'error',
      error: String(e?.message ?? e), ms: Date.now() - t0,
    }, 500);
  } finally {
    // ★ 铁律：无论如何销毁
    if (sb) await destroy(sb);
    busy = false;
  }
}

// ---------- helpers ----------
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: h(env) });
}
function h(env) {
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': env.APP_ORIGIN || '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-orion-token',
  };
}
function cors(env) {
  return {
    'access-control-allow-origin': env.APP_ORIGIN || '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-orion-token',
    'access-control-max-age': '86400',
  };
}
