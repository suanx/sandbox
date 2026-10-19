// AI 任务执行器 · 调试台
const EP_KEY = 'tl_ep', TK_KEY = 'tl_tk';

const el = {
  ep: document.getElementById('ep'),
  tk: document.getElementById('tk'),
  save: document.getElementById('save'),
  task: document.getElementById('task'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  log: document.getElementById('log'),
  stat: document.getElementById('statChip'),
  turn: document.getElementById('turnChip'),
  toast: document.getElementById('toast'),
};

let abortCtl = null;

el.ep.value = localStorage.getItem(EP_KEY) || el.ep.value;
el.tk.value = localStorage.getItem(TK_KEY) || '';
el.save.onclick = () => {
  localStorage.setItem(EP_KEY, el.ep.value.trim());
  localStorage.setItem(TK_KEY, el.tk.value.trim());
  toast('已保存');
};

function toast(msg, bad = false) {
  el.toast.textContent = msg;
  el.toast.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.toast.className = 'toast'), 2600);
}
function ts() { return new Date().toTimeString().slice(0, 8); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function print(text, cls = 'out') {
  const row = document.createElement('div');
  row.className = 'row ' + cls;
  row.innerHTML = `<span class="ts">${ts()}</span>${esc(text)}`;
  el.log.appendChild(row);
  el.log.scrollTop = el.log.scrollHeight;
}
function stat(t, cls = '') { el.stat.textContent = t; el.stat.className = 'chip ' + cls; }

const FINISH_TEXT = {
  done: '完成', timeout: '超时中断', max_turns: '达到最大轮数',
  llm_error: 'LLM 调用失败', parse_error: '模型输出异常',
  sandbox_error: '沙盒创建失败', error: '执行出错',
};

async function run() {
  const task = el.task.value.trim();
  if (!task) return;
  print('◆ ' + task, 'sys');
  el.task.value = '';
  el.send.disabled = true;
  el.stop.disabled = false;
  stat('执行中…', 'run');
  el.turn.textContent = '0 步';

  const headers = { 'content-type': 'application/json' };
  const token = el.tk.value.trim();
  if (token) {
    headers.authorization = 'Bearer ' + token;
    headers['x-orion-token'] = 'Bearer ' + token; // EdgeOne 会覆盖 Authorization，双头保平安
  }
  abortCtl = new AbortController();

  try {
    const res = await fetch(el.ep.value.trim(), {
      method: 'POST', headers, body: JSON.stringify({ task }), signal: abortCtl.signal,
    });
    const j = await res.json().catch(() => null);

    if (res.status === 401) { print('[401] token 不对', 'err'); stat('鉴权失败', 'bad'); toast('token 错误', true); return; }
    if (res.status === 429) { print('[429] 上一个任务还在跑', 'warn'); stat('忙', 'bad'); toast('忙，稍后重试', true); return; }
    if (!j) { print(`[${res.status}] 响应解析失败`, 'err'); stat('出错', 'bad'); return; }

    // 逐轮渲染
    const turns = j.turns || [];
    for (const t of turns) {
      const box = document.createElement('div');
      box.className = 'turn';
      box.innerHTML =
        `<div class="th">第 ${t.i} 步</div>` +
        (t.thought ? `<div class="thought">${esc(t.thought)}</div>` : '') +
        (t.command ? `<div class="cmd">${esc(t.command)}</div>` : '') +
        `<div class="out">${esc(t.output || '(无输出)')}</div>`;
      el.log.appendChild(box);
      el.log.scrollTop = el.log.scrollHeight;
      el.turn.textContent = `${t.i} 步`;
    }

    if (j.answer) {
      const f = document.createElement('div');
      f.className = 'final';
      f.innerHTML = `<span class="lab">最终结果</span>${esc(j.answer)}`;
      el.log.appendChild(f);
    }
    if (j.error) print('[error] ' + j.error, 'err');

    const ft = FINISH_TEXT[j.finish] || j.finish || '未知';
    const ok = j.finish === 'done';
    print(`-- ${ft} · 共 ${turns.length} 步 · 耗时 ${(j.ms / 1000).toFixed(1)}s · 沙盒已销毁 --`, ok ? 'ok' : 'warn');
    stat(ft, ok ? 'ok' : 'bad');
  } catch (e) {
    if (e && e.name === 'AbortError') {
      print('-- 已取消（服务端任务会在预算内自行收尾并销毁沙盒）--', 'warn');
      stat('已取消', 'bad');
    } else {
      print('-- 网络错误: ' + e.message, 'err');
      stat('出错', 'bad');
    }
  } finally {
    el.send.disabled = false;
    el.stop.disabled = true;
    abortCtl = null;
    el.task.focus();
  }
}

el.send.addEventListener('click', run);
el.stop.addEventListener('click', () => { if (abortCtl) abortCtl.abort(); });
el.task.addEventListener('keydown', e => { if (e.key === 'Enter' && !el.send.disabled) run(); });

print('Tensorlake × AI 自主任务执行器', 'out');
print('说一句话描述任务，AI 自己在沙盒里跑命令，直到完成。', 'sys');
print('每个任务：新建沙盒 → 多轮执行 → 结束立刻销毁，零留存。', 'sys');
print('先在下面填好 Endpoint 和 Token。', 'warn');
el.task.focus();
