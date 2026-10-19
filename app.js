// tl-agent 状态页 · 服务探活
// 原理：POST 空 body 到 /api/chat —— 鉴权段先于建沙盒执行，全程零成本：
//   401 → 服务在线（已绑定 orion，鉴权开启）
//   503 → 服务锁定（未配置 ORION_BASE_URL 白名单）
//   其他 HTTP 状态 → 服务在线；网络错误 → 不可达
const REFRESH_MS = 30_000;
const EP = new URLSearchParams(location.search).get('ep') || '/api/chat';

const el = {
  livePulse: document.getElementById('livePulse'),
  liveText: document.getElementById('liveText'),
  status: document.getElementById('status'),
  stPulse: document.getElementById('stPulse'),
  stLabel: document.getElementById('stLabel'),
  stDetail: document.getElementById('stDetail'),
  refresh: document.getElementById('refresh'),
};

function ts() { return new Date().toTimeString().slice(0, 8); }

function render(state, label, detail) {
  const pulseCls = { on: 'pulse on', lock: 'pulse lock', bad: 'pulse bad', chking: 'pulse' }[state];
  el.livePulse.className = pulseCls;
  el.liveText.textContent = label;
  el.stPulse.className = pulseCls + ' big';
  el.stLabel.textContent = label;
  el.status.className = 'status panel ' + state;
  el.stDetail.textContent = detail;
}

async function check() {
  render('chking', '正在检查服务状态…', `探测 ${EP} · 上次检查 ${ts()}`);
  try {
    const res = await fetch(EP, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (res.status === 503) {
      render('lock', '服务锁定', '服务端未绑定 orion 白名单（ORION_BASE_URL 未配置），已拒绝服务');
    } else if (res.status === 401) {
      render('on', '服务运行中', `HTTP ${res.status} · orion 鉴权开启 · ${ts()} 起每 30s 自动检查`);
    } else {
      render('on', '服务运行中', `HTTP ${res.status} · ${ts()} 起每 30s 自动检查`);
    }
  } catch {
    render('bad', '无法连接', `探测 ${EP} 失败 · ${ts()}`);
  }
}

el.refresh.addEventListener('click', check);
setInterval(check, REFRESH_MS);
check();
