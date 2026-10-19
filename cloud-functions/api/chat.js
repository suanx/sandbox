// ============================================================================
// AI 自主任务执行器
// POST /api/chat   body: { "task": "用 python 分析..." }
//
// 两种响应模式（2026-10-19 v4 流式化）：
//   ① JSON（默认）：一次性返回 {answer, turns, finish, ms}——旧客户端兼容；
//   ② SSE（body.stream === true 或 Accept: text/event-stream）：
//      OpenAI delta 兼容流，边跑边推——
//        thought（思考）        → delta.reasoning_content（App 思考面板）
//        命令 + 执行输出（过程） → delta.reasoning_content
//        最终 answer（结论）    → delta.content（正文，分段推送有打字感）
//      结束帧 [DONE]；意外异常推 {"error":{...}} 帧后收尾。
//      流前错误（鉴权/busy）仍是普通 JSON 状态码，Dio/客户端照常处理。
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
//
// ★ 绑定红线（2026-10-19）：本服务强制绑定 orion_agent_cloud，无独立运行
//   模式——鉴权只有一条路（ORION_BASE_URL 白名单 + introspect 远端校验），
//   未配置即 503 锁死；orion 不可达时 fail-closed（401）。任何"加回本地
//   密钥比对/免鉴权通道"的改动都等于重新打开免鉴权裸奔，禁止。
// ============================================================================

import { decide } from '../lib/llm.js';
import { create, exec, destroy } from '../lib/sandbox.js';

// 单实例内的并发锁：一个人用、一个任务一个沙盒，忙了直接拒绝
let busy = false;

// 单命令等待上限（默认 90s，低于 BUDGET_MS 预算；只放弃等待不杀进程）
function cmdTimeoutMs(env) {
  return clamp(Number(env.CMD_TIMEOUT_MS || 90_000), 1_000, 300_000);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * orion_agent_cloud 令牌远端校验（2026-10-19 对接）。
 * GET {ORION_BASE_URL}/api/auth/introspect，200 即有效（401 = 令牌无效/过期）。
 * 5s 超时：introspect 挂住时快速失败，不让鉴权环节拖住整个任务。
 */
async function orionIntrospect(env, token) {
  const base = String(env.ORION_BASE_URL || '').trim().replace(/\/+$/, '');
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

  // ---------- 鉴权（v2：APP_TOKEN 已取消，ORION_BASE_URL 白名单制）----------
  // 白名单机制：ORION_BASE_URL 即访问控制总开关。
  //   已配置 → 请求必须携带有效 orion 令牌（JWT eyJ… / 设备令牌 dt_…），
  //            经 {ORION_BASE_URL}/api/auth/introspect 远端校验，200 放行。
  //   未配置 → 服务锁定，一律 503（无白名单不开放，杜绝免鉴权刷额度）。
  // 载体：X-Orion-Token 优先（EdgeOne 会把 Authorization 覆盖成平台 COS
  // 签名，与 orion 侧同款坑），Authorization 作回退。
  const orionBase = String(env.ORION_BASE_URL || '').trim();
  if (!orionBase) {
    // 强制绑定：配置缺失 = 部署事故，每次都打 error 让它在线上日志可见
    console.error('[auth] 服务锁定：ORION_BASE_URL 未配置，本服务强制绑定 orion_agent_cloud，拒绝服务');
    return json(env, { error: 'service_locked: 未配置 ORION_BASE_URL，白名单未启用，拒绝服务' }, 503);
  }
  const headerVal =
    req.headers?.get?.('x-orion-token') || req.headers?.get?.('authorization') || '';
  const raw = headerVal.replace(/^Bearer\s+/i, '').trim();
  if (!raw) return json(env, { error: 'unauthorized: 缺少 orion 令牌（X-Orion-Token 头）' }, 401);
  const v = await orionIntrospect(env, raw);
  if (!v.ok) {
    // orion 依赖故障（不可达/超时）是运维事件，要在日志可见；普通令牌无效是正常拒绝，不刷日志
    if (String(v.reason || '').includes('不可达')) {
      console.error(`[auth] orion 依赖不可达（fail-closed 拒绝）: ${v.reason}`);
    }
    return json(env, { error: `unauthorized (${v.reason})` }, 401);
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

  // SSE 模式判定：显式 stream:true 优先，Accept 头兜底。
  const wantStream = body.stream === true ||
      String(req.headers?.get?.('accept') || '').includes('text/event-stream');

  try {
    if (wantStream) {
      return streamResponse(env, async (send) => {
        try {
          const r = await runTaskLoop(env, {
            task, directCmd, maxTurns, budgetMs, cmdMs,
            emit: (kind, text) => {
              if (!text) return;
              send(kind === 'reasoning'
                ? { choices: [{ delta: { reasoning_content: text } }] }
                : { choices: [{ delta: { content: text } }] });
            },
          });
          // 结论补推：过程（思考/命令）走了 reasoning 通道，正文目前还是空的。
          // answer 分段推送制造打字感——与 forge 的逐字流体验对齐。
          if (r.answer) {
            for (const chunk of chunkText(r.answer, 120)) {
              send({ choices: [{ delta: { content: chunk } }] });
              await sleep(15);
            }
          }
          // OpenAI 风格收尾帧：done → stop，其余 finish 原因透出（诊断用）
          send({ choices: [{ delta: {}, finish_reason: r.finish === 'done' ? 'stop' : r.finish }] });
        } catch (e) {
          // 循环外层意外异常：error 帧（客户端据此给明确报错），再正常收尾
          console.error(`[stream] 任务异常: ${e?.message ?? e}`);
          send({ error: { message: `沙盒任务异常: ${String(e?.message ?? e).slice(0, 300)}` } });
          send({ choices: [{ delta: {}, finish_reason: 'error' }] });
        } finally {
          // ★ busy 锁必须在流结束（沙盒销毁）后才释放——Response 先于任务
          //   返回，外层 finally 在任务还跑着时就执行了，不能放那里。
          busy = false;
        }
      });
    }

    // ---------- JSON 模式（原 v3 行为，一字未动语义） ----------
    const r = await runTaskLoop(env, { task, directCmd, maxTurns, budgetMs, cmdMs, emit: null });
    busy = false;
    if (r.error) {
      return json(env, { answer: '', turns: r.turns, finish: 'error', error: r.error, ms: r.ms }, 500);
    }
    return json(env, { answer: r.answer, turns: r.turns, finish: r.finish, ms: r.ms });
  } catch (e) {
    busy = false;
    throw e;
  }
}

// ---------- 任务主循环（JSON / SSE 共用） ----------

/**
 * 跑一个沙盒任务，返回 {answer, turns, finish, ms[, error]}。
 *
 * emit(kind, text)：SSE 模式的增量出口（kind='reasoning' 思考与过程 /
 * 'content' 正文）；JSON 模式传 null，只收集不推送。
 * 沙盒的销毁在本函数 finally 保证；busy 锁由调用方管理。
 */
async function runTaskLoop(env, { task, directCmd, maxTurns, budgetMs, cmdMs, emit }) {
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
      turns.push({ i: 1, thought: '', command: directCmd, output: out });
      if (emit) {
        emit('reasoning', `$ ${directCmd}\n${truncateOut(out)}\n`);
      } else {
        answer = out;
      }
      return { answer: answer || out, turns, finish: 'done', ms: Date.now() - t0 };
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

      // ★ 流式：思考（含轮次标记）走 reasoning 通道，与 forge 的思考面板同构
      if (emit && d.thought) emit('reasoning', `【第 ${i} 轮】${d.thought}\n`);

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

      // ★ 流式：命令与输出是任务过程，走 reasoning 通道（正文只留最终结论）
      if (emit) emit('reasoning', `$ ${d.command}\n${truncateOut(output)}\n\n`);

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

    return { answer, turns, finish, ms: Date.now() - t0 };
  } catch (e) {
    // 兜底：JSON 模式走 500；SSE 模式由调用方的 error 帧承接
    return { answer: '', turns, finish: 'error', error: String(e?.message ?? e), ms: Date.now() - t0 };
  } finally {
    // ★ 铁律：无论如何销毁
    if (sb) await destroy(sb);
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

/**
 * SSE 流式响应：ReadableStream + 逐帧 enqueue。
 * EdgeOne 云函数支持流式 Response（forge /agent/chat SSE 同环境已验证）。
 * send() 必须在 start 回调内同步/await 使用；finally 关流。
 */
function streamResponse(env, run) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(ctrl) {
      const send = (obj) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        await run(send);
      } finally {
        try { ctrl.enqueue(enc.encode('data: [DONE]\n\n')); } catch { /* 流已坏 */ }
        try { ctrl.close(); } catch { /* 已关 */ }
      }
    },
  }), {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': env.APP_ORIGIN || '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization,x-orion-token',
    },
  });
}

/** 把最终 answer 按 ~n 字符切段（伪流式，段间 sleep 由调用方控制）。 */
function chunkText(s, n) {
  const t = String(s ?? '');
  const out = [];
  for (let i = 0; i < t.length; i += n) out.push(t.slice(i, i + n));
  return out.length ? out : [t];
}

/** 过程输出塞思考通道前的截断（防超长输出把 reasoning 面板撑爆）。 */
function truncateOut(s) {
  const t = String(s ?? '');
  return t.length > 4000 ? t.slice(0, 4000) + '\n...(输出已截断)' : t;
}
