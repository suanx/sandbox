// ============================================================================
// LLM 适配层 —— OpenAI 兼容接口（DeepSeek / 通义 / Kimi / 自建网关等）
//
// 只做一件事：把「任务 + 历史命令输出」喂给模型，拿回下一步要执行的命令。
// 强制模型回 JSON，但【不依赖 response_format】（很多兼容网关不支持），
// 靠 prompt 约束 + 容错解析兜底。
// ============================================================================

const SYSTEM = `你是一个在 Linux 沙盒中自主完成任务的 AI 助手。
环境：Ubuntu（bash），已预装 python3 / pip / nodejs / npm / curl / wget / git / unzip /
ca-certificates。你的命令固定在可写工作目录 /home/tl-user/workspace 下执行，文件操作请用
相对路径或写在该目录（/tmp 也可写）。/ 与 /workspace 不可写，不要尝试在其中创建文件。
缺什么包装：apt-get update && apt-get install -y --no-install-recommends <包名>；
Python 库 pip install。时区为 UTC，报时间时自行换算或用 date。

每一轮你必须只输出一个 JSON 对象，不要输出任何其它文字，不要用 markdown 代码块包裹：
{"thought": "简短说明你为什么这么做", "command": "要执行的一条 shell 命令", "done": false}

当你判断任务已完成时，输出：
{"thought": "说明完成情况", "command": "", "done": true, "answer": "给用户的最终回答"}

硬性规则：
1. 一次只给一条命令，不要链式用 && 拼多件事。
2. 命令必须非交互：禁止 vim / nano / 需要键盘输入的命令。写文件请用 cat << 'EOF' > file 或 printf。
3. 需要安装依赖就用 pip install 或 apt-get install -y，不要询问。
4. 如果上一条命令报错，分析原因并换一种方式重试，不要重复同样的错误命令。
5. 想查看结果就用 cat / ls / head 等命令输出出来，不要说"已完成"却什么都没验证。
6. 不要执行危险命令（rm -rf / 等），沙盒虽隔离但请保持克制。
7. thought 用中文，command 用 shell。`;

/** 调模型，返回 {thought, command, done, answer} */
export async function decide(env, task, history, turnInfo) {
  const key = env.LLM_API_KEY;
  if (!key) throw new Error('LLM_API_KEY 未配置');
  const model = env.LLM_MODEL || 'deepseek-chat';

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildUserMsg(task, history, turnInfo) },
  ];

  const endpoint = normalizeEndpoint(env.LLM_BASE_URL || 'https://api.deepseek.com/v1');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: Number(env.LLM_TEMPERATURE ?? 0.2),
      // 不开 response_format：多数兼容网关不支持，靠 prompt + 容错解析
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 300)}`);
  }

  const j = await res.json().catch(() => null);
  const raw = j?.choices?.[0]?.message?.content ?? '';
  return parseDecision(raw);
}

/** 拼装用户消息：任务 + 之前每轮的命令与输出 */
function buildUserMsg(task, history, turnInfo) {
  let s = `任务：${task}\n`;
  if (turnInfo) s += `\n（当前第 ${turnInfo.i} 轮，最多 ${turnInfo.max} 轮，请尽快收敛）\n`;
  if (history.length) {
    s += '\n以下是你已经执行过的命令及其输出：\n';
    for (const h of history) {
      s += `\n$ ${h.command}\n${truncate(h.output)}\n`;
    }
    s += '\n根据上面的结果，决定下一步。';
  } else {
    s += '\n这是第一轮，请给出第一条命令。';
  }
  return s;
}

/** 容错解析：应对 ```json 包裹、前后废话、多段 JSON */
function parseDecision(raw) {
  const text = String(raw || '').trim();
  let obj = null;

  // ① 直接解析
  try { obj = JSON.parse(text); } catch {}

  // ② 去掉 markdown 代码块
  if (!obj) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { obj = JSON.parse(m[1].trim()); } catch {} }
  }

  // ③ 截取第一个 {...} 块（配平大括号）
  if (!obj) {
    const start = text.indexOf('{');
    if (start >= 0) {
      let depth = 0, end = -1;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > start) { try { obj = JSON.parse(text.slice(start, end + 1)); } catch {} }
    }
  }

  if (!obj) {
    // 完全解析不出来：让上层把它当作一次失败重试
    return { thought: '模型输出无法解析', command: '', done: false, parseError: true, raw: text.slice(0, 500) };
  }

  return {
    thought: String(obj.thought ?? '').slice(0, 500),
    command: String(obj.command ?? '').trim(),
    done: obj.done === true || obj.done === 'true',
    answer: String(obj.answer ?? obj.thought ?? '').slice(0, 4000),
    parseError: false,
  };
}

function truncate(s) {
  const t = String(s ?? '');
  // 防止超长输出把上下文撑爆（也防止烧 token）
  return t.length > 4000 ? t.slice(0, 4000) + '\n...(输出已截断)' : t;
}

function normalizeEndpoint(base) {
  let b = String(base).replace(/\/+$/, '');
  if (b.endsWith('/chat/completions')) return b;
  return b + '/chat/completions';
}
