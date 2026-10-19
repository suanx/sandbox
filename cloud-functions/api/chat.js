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
// 会话模式（2026-10-19 方案 A，服务端零状态）：
//   body 增 { session?, sandboxId?, end? }。
//   - sandboxId 是上次响应回传的复用凭据：connect 附着已有沙盒，文件系统/
//     已装依赖延续；失效（2h 上限被平台回收）自动回落新建，对用户无感。
//   - 任务结束默认【不销毁不挂起】——沙盒保持 running 到 2h 上限由平台
//     自动回收（Free 层免费；不产生任何快照）。SESSION_SUSPEND=1 可选
//     启用挂起（付费层省钱）。
//   - 响应回传 sandboxId（JSON 字段 / SSE 的 sandbox_session 元数据帧），
//     客户端保管、每次请求带回；end:true + sandboxId 主动销毁。
//   - 并发锁按 session 隔离：不同会话可并发，普通任务仍全局互斥。
//
// 流程（关键：第一轮 LLM 调用在建沙盒【之前】——省掉一次思考时间的沙盒空转）：
//
//   LLM 决定第一条命令
//        ↓
//   建沙盒 ──→ 执行 ──→ 输出回灌 LLM ──→ 下一条命令 ──→ ... ──→ done
//        ↓
//   任务结束 / 超时 / 出错 → 立刻 terminate（finally 保证）
//
// ★ 绑定红线（2026-10-19）：本服务强制绑定 orion_agent_cloud，无独立运行
//   模式——鉴权只有一条路（ORION_BASE_URL 白名单 + introspect 远端校验），
//   未配置即 503 锁死；orion 不可达时 fail-closed（401）。任何"加回本地
//   密钥比对/免鉴权通道"的改动都等于重新打开免鉴权裸奔，禁止。
// ============================================================================

import { decide } from '../lib/llm.js';
import { create, createSession, connect, exec, initWorkdir, WORKDIR, suspendSafe, resumeSafe, destroy, destroyAll } from '../lib/sandbox.js';

// 并发锁：按「执行单元」隔离——无 session 的普通任务共用 '__single__'
// （保持原全局 busy 语义），会话任务按 session id 各自一把锁，
// 不同会话可并发（各自独立沙盒，互不阻塞）。
const busyLocks = new Set();

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

  // 会话模式（2026-10-19 方案 A）：客户端持 sandboxId 作为会话令牌。
  //   session    会话标识（App 按聊天会话生成，仅作并发锁粒度用）
  //   sandboxId  上一次响应回传的沙盒 id（复用凭据；首次请求没有）
  //   end:true   结束会话 → 销毁沙盒
  // 服务端零状态：无 KV、无 name 留存；沙盒保持 running 到
  // SESSION_TIMEOUT_SECS（默认 2h）由平台自动回收，不产生快照。
  const session = String(body.session ?? '').slice(0, 80);
  const clientSandboxId = String(body.sandboxId ?? '').slice(0, 120);
  const endSession = body.end === true;
  const keepAlive = Boolean(session || clientSandboxId);

  // end 模式：销毁会话沙盒即刻返回（不需要 task）
  if (endSession && clientSandboxId) {
    try {
      const sb = await connect(env, clientSandboxId);
      await destroy(sb);
      return json(env, { finish: 'ended', sandboxId: clientSandboxId });
    } catch (e) {
      // 沙盒已不存在/已回收：会话本来就该算结束了
      return json(env, { finish: 'ended', sandboxId: clientSandboxId, note: '沙盒已不存在（可能已超时回收）' });
    }
  }

  // cleanup 模式：销毁命名空间内全部遗留沙盒（孤儿清理；Free 并发 1 被占
  // 时的手动兜底，也供调度/运维脚本调用）。可与 end 同时省略其它字段。
  if (body.cleanup === true) {
    let killed = [];
    let err = '';
    try { killed = await destroyAll(env); } catch (e) { err = String(e?.message ?? e); }
    return json(env, { finish: 'cleaned', killed, ...(err ? { error: err } : {}) });
  }

  if (!task && !directCmd) { return json(env, { error: 'task 不能为空' }, 400); }

  // 并发锁按「执行单元」：无 session 共用 '__single__'（原全局 busy 语义），
  // 会话任务按 session id 各一把锁（不同会话独立沙盒，互不阻塞）。
  const lockKey = session || '__single__';
  if (busyLocks.has(lockKey)) return json(env, { error: 'busy: 上一个任务还在跑' }, 429);
  busyLocks.add(lockKey);

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
          // ★ 流级看门狗（2026-10-19）：沙盒/平台 API 若卡住（已全部加 20s
          //   超时，此处再兜底），必须在 EdgeOne 120s 平台强杀【之前】发可
          //   解析的 error 帧正常关流——被强杀的流客户端只能看到静默 EOF，
          //   表现为「沙盒未返回内容」这类无根因报错。
          const WATCHDOG_MS = clamp(Number(env.STREAM_WATCHDOG_MS || 100_000), 30_000, 115_000);
          const loop = runTaskLoop(env, {
            task, directCmd, maxTurns, budgetMs, cmdMs,
            keepAlive, clientSandboxId,
            emit: (kind, text) => {
              if (!text) return;
              send(kind === 'reasoning'
                ? { choices: [{ delta: { reasoning_content: text } }] }
                : { choices: [{ delta: { content: text } }] });
            },
          }).then(
            (r) => ({ ok: true, r }),
            (e) => ({ ok: false, e }),
          );
          const outcome = await Promise.race([
            loop,
            new Promise((res) => setTimeout(() => res({ watchdog: true }), WATCHDOG_MS)),
          ]);
          if (outcome.watchdog) {
            console.error('[stream] 看门狗超时，主动关流');
            send({ error: { message: `沙盒任务看门狗超时（${Math.round(WATCHDOG_MS / 1000)}s）：任务卡在沙盒操作上已中止；沙盒将在 2h 上限自动回收，请稍后重试` } });
            send({ choices: [{ delta: {}, finish_reason: 'watchdog' }] });
            return;
          }
          if (!outcome.ok) throw outcome.e;
          const r = outcome.r;
          // 顶层意外异常（finish=error）的原因必须透出——否则用户只看到
          // 「未返回内容」，无法定位（2026-10-19 诊断实证）
          if (r.error) {
            console.error(`[stream] 任务失败: ${r.error}`);
            send({ error: { message: `沙盒任务异常: ${String(r.error).slice(0, 300)}` } });
          }
          // 会话元数据帧（客户端据此记住 sandboxId 供下次复用；
          // 无 choices 字段，OpenAI 通用解析器天然跳过）
          if (r.sandboxId) send({ sandbox_session: { id: r.sandboxId, reused: r.reused === true } });
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
          // ★ busy 锁必须在流结束（沙盒收尾）后才释放——Response 先于任务
          //   返回，外层 finally 在任务还跑着时就执行了，不能放那里。
          busyLocks.delete(lockKey);
        }
      });
    }

    // ---------- JSON 模式（v3 行为 + 会话字段） ----------
    const r = await runTaskLoop(env, { task, directCmd, maxTurns, budgetMs, cmdMs, keepAlive, clientSandboxId, emit: null });
    busyLocks.delete(lockKey);
    if (r.error) {
      return json(env, { answer: '', turns: r.turns, finish: 'error', error: r.error, ms: r.ms }, 500);
    }
    return json(env, {
      answer: r.answer, turns: r.turns, finish: r.finish, ms: r.ms,
      ...(r.sandboxId ? { sandboxId: r.sandboxId, reused: r.reused === true } : {}),
    });
  } catch (e) {
    busyLocks.delete(lockKey);
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
async function runTaskLoop(env, { task, directCmd, maxTurns, budgetMs, cmdMs, emit, keepAlive, clientSandboxId }) {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const turns = [];
  const history = [];
  let sb = null;
  let sandboxId = null; // 会话模式回传给客户端的复用凭据
  let reused = false;
  let answer = '';
  let finish = 'done';

  try {
    // ---------- 直接命令模式（不走 LLM，方便调试沙盒） ----------
    // 会话模式下同样可用：复用/创建会话沙盒跑直通命令，跑完不销毁。
    if (!task && directCmd) {
      sb = keepAlive ? await obtainSessionSandbox(env, clientSandboxId, emit) : await create(env);
      sandboxId = keepAlive ? sb?.sandboxId ?? null : null;
      reused = keepAlive && sb?._reused === true;
      await initWorkdir(sb);
      const out = await exec(sb, directCmd, cmdMs, WORKDIR);
      turns.push({ i: 1, thought: '', command: directCmd, output: out });
      if (emit) {
        emit('reasoning', `$ ${directCmd}\n${truncateOut(out)}\n`);
      } else {
        answer = out;
      }
      return { answer: answer || out, turns, finish: 'done', ms: Date.now() - t0, sandboxId, reused };
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

      // ② 第一条命令出来了才准备沙盒（省钱：LLM 思考期间不占用）
      //    会话模式：先尝试复用客户端带来的 sandboxId，失败回落新建。
      try {
        if (!sb) {
          if (keepAlive) {
            sb = await obtainSessionSandbox(env, clientSandboxId, emit);
            sandboxId = sb?.sandboxId ?? null;
            reused = sb?._reused === true;
          } else {
            sb = await create(env);
          }
          await initWorkdir(sb);
        }
      } catch (e) {
        turns.push({ i, thought: d.thought, command: d.command, output: `沙盒创建失败: ${e.message}` });
        finish = 'sandbox_error';
        break;
      }

      // ③ 执行（带单命令等待上限，防挂死命令拖穿预算）
      const output = await exec(sb, d.command, cmdMs, WORKDIR);
      turns.push({ i, thought: d.thought, command: d.command, output });
      history.push({ command: d.command, output });

      // ★ 流式：命令与输出是任务过程，走 reasoning 通道（正文只留最终结论）
      if (emit) emit('reasoning', `$ ${d.command}\n${truncateOut(output)}\n\n`);

      // 再检查一次预算，避免执行完已超时还在继续
      if (Date.now() > deadline) { finish = 'timeout'; break; }
    }

    if (!answer) {
      // 失败原因透出（2026-10-19）：sandbox_error / llm_error / parse_error
      // 的真实错误在 turns 里，App 不展示 turns——之前全被「任务结束，未给
      // 出明确结论」掩盖，用户看不到「TENSORLAKE_API_KEY 未配置」这类根因。
      const lastOutput = turns.length ? String(turns[turns.length - 1]?.output ?? '') : '';
      if (finish === 'sandbox_error') {
        answer = `沙盒创建/执行失败：${lastOutput || '原因未知，请稍后重试'}`;
      } else if (finish === 'llm_error') {
        const t = turns.length ? String(turns[turns.length - 1]?.thought ?? '') : '';
        answer = `沙盒侧模型调用失败：${t || '请检查沙盒服务的 LLM 配置'}`;
      } else if (finish === 'parse_error') {
        answer = '沙盒侧模型输出无法解析，已终止。请重试或换更明确的任务描述。';
      } else if (finish === 'timeout') {
        answer = `已达时间预算（${Math.round(budgetMs / 1000)}s），未完成。已执行 ${turns.length} 步。`;
      } else {
        answer = `已达最大轮数 ${maxTurns}，未完成。`;
      }
    }
    if (finish === 'done' && turns.length >= maxTurns) finish = 'max_turns';

    return { answer, turns, finish, ms: Date.now() - t0, sandboxId, reused };
  } catch (e) {
    // 兜底：JSON 模式走 500；SSE 模式由调用方的 error 帧承接
    return { answer: '', turns, finish: 'error', error: String(e?.message ?? e), ms: Date.now() - t0 };
  } finally {
    // ★ 收尾铁律：
    //   普通任务（无会话）→ 无论成败必销毁（防烧钱）；
    //   会话任务 → **不销毁不挂起**（用户明确不要快照）：沙盒保持 running，
    //   由 SESSION_TIMEOUT_SECS（默认 2h）到点平台自动回收——2h 内客户端
    //   可随时凭 sandboxId 复用；suspend 仅在 SESSION_SUSPEND=1 时启用
    //   （付费层省钱选项）。
    //   沙盒创建失败时 sb 为 null，无需收尾。
    if (sb) {
      if (keepAlive && sandboxId) {
        if (String(env.SESSION_SUSPEND || '') === '1') await suspendSafe(sb);
        // 默认：什么都不做，保持 running
      } else {
        await destroy(sb);
      }
    }
  }
}

/**
 * 会话沙盒获取：connect 客户端凭据 → 失败（已回收/不存在）回落新建。
 * 新建撞上并发配额（Free 层并发 1，遗留孤儿沙盒占位——App 丢失 id/跨端
 * 场景）时自动清理全部遗留沙盒后重试一次（自建单用户，现存即孤儿）。
 * 返回的句柄带 _reused 标记与 sandboxId，供响应回传客户端。
 */
async function obtainSessionSandbox(env, clientSandboxId, emit) {
  if (clientSandboxId) {
    try {
      const sb = await connect(env, clientSandboxId);
      sb._reused = true;
      if (emit) emit('reasoning', `（已接回会话沙盒，环境与文件延续）\n`);
      return sb;
    } catch (e) {
      // 沙盒已被 2h 上限回收 / id 失效：静默回落新建（对用户无感）
      if (emit) emit('reasoning', `（原会话沙盒已失效，开新沙盒继续）\n`);
    }
  }
  try {
    const sb = await createSession(env);
    if (emit) emit('reasoning', `（已创建会话沙盒，2 小时内环境持续可用）\n`);
    return sb;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/quota|running|concurrency/i.test(msg)) throw e;
    // 并发配额被占：清掉遗留沙盒（含本请求无法得知 id 的孤儿）后重试一次
    if (emit) emit('reasoning', `（并发配额被遗留沙盒占用，自动清理后重试…）\n`);
    let killed = [];
    try { killed = await destroyAll(env); } catch { /* 清理失败则按原错误抛出 */ }
    if (emit) emit('reasoning', killed.length
      ? `（已清理 ${killed.length} 个遗留沙盒，重新创建）\n`
      : `（未发现可清理的沙盒，直接重试创建）\n`);
    const sb = await createSession(env);
    if (emit) emit('reasoning', `（已创建会话沙盒，2 小时内环境持续可用）\n`);
    return sb;
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
