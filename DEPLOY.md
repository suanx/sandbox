# Tensorlake × AI 自主任务执行器 — 部署手册

## 一、它做什么

你说一句人话，AI 自己在沙盒里跑命令，直到完成：

```
"写一个 python 脚本算斐波那契前 20 项并运行"
   ↓
AI: 先看看环境 → python3 --version
AI: 写脚本     → cat << 'EOF' > fib.py ...
AI: 运行       → python3 fib.py
AI: 完成       → done, answer
   ↓
沙盒销毁，零留存
```

**每轮循环**：LLM 决定命令 → 沙盒执行 → 输出回灌 LLM → 决定下一步。

---

## 二、关键设计：第一轮 LLM 调用在建沙盒之前

```
LLM 决定第一条命令   ← 这段时间【没有沙盒】，不烧钱
        ↓
建沙盒 → 执行 → 输出回灌 LLM → ... → done → 销毁
```

省掉了一次 LLM 思考时间的沙盒空转。后续轮次沙盒必须活着（你要连续写文件、装依赖），LLM 思考时空转是"一个任务一个沙盒"的必要代价。

---

## 三、部署

```bash
npm i -g edgeone
edgeone login
cd tl-agent
edgeone pages init
edgeone pages deploy
```

⚠️ **不要用控制台「直接上传」**：不执行 `npm install`，tensorlake SDK 装不上。

---

## 四、环境变量（项目设置 → 环境变量）

### 必填

| 变量 | 说明 |
|---|---|
| `TENSORLAKE_API_KEY` | cloud.tensorlake.ai 控制台拿 |
| `LLM_API_KEY` | 你的模型服务商 API Key |
| `ORION_BASE_URL` | orion_agent_cloud 地址（如 `https://or.950155.xyz`）。**白名单总开关**：配置后只有持有效 orion 令牌（JWT `eyJ` / 设备令牌 `dt_`）的请求可调用，经 `/api/auth/introspect` 远端校验；**未配置则服务锁定（一律 503）**，杜绝免鉴权刷额度 |

### LLM 相关

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容地址，代码自动补 `/chat/completions` |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `LLM_TEMPERATURE` | `0.2` | 低温度，让输出更稳定 |

常见兼容地址：
- DeepSeek：`https://api.deepseek.com/v1`
- 通义千问：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- Moonshot：`https://api.moonshot.cn/v1`
- 自建网关：填你的地址即可

### 可选

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAX_TURNS` | 8 | 最多几轮（1–20） |
| `BUDGET_MS` | 110000 | 时间预算毫秒，到点强制收尾销毁 |
| `CMD_TIMEOUT_MS` | 90000 | 单命令等待上限（只放弃等待不杀进程，防挂死命令拖穿预算），1s–300s |
| `TL_CPUS` / `TL_MEMORY_MB` / `TL_DISK_MB` | 1 / 1024 / 10240 | Free 档上限 |
| `TL_TIMEOUT_SECS` | 300 | 空闲阈值兜底 |
| `TL_IMAGE` | 空 | 预装依赖的镜像名 |
| `APP_ORIGIN` | `*` | CORS 来源 |

**不需要 KV。**

---

## 五、API 契约

### 请求
```
POST /api/chat
x-orion-token: Bearer <orion JWT 或 dt_ 设备令牌>
{ "task": "写一个 python 脚本算斐波那契前 20 项并运行" }
```

也支持 `{"cmd": "ls -la"}` 直接跑单条命令（不走 LLM，用于调试沙盒）。

### 响应
```json
{
  "answer": "前 20 项斐波那契为：0 1 1 2 3 ...",
  "turns": [
    { "i": 1, "thought": "先看环境", "command": "python3 --version", "output": "Python 3.12.1" },
    { "i": 2, "thought": "写脚本", "command": "cat << 'EOF' > fib.py\n...", "output": "" }
  ],
  "finish": "done",
  "ms": 8400
}
```

### `finish` 取值

| 值 | 含义 |
|---|---|
| `done` | 正常完成 |
| `timeout` | 到时间预算，未完成（沙盒已销毁） |
| `max_turns` | 达到最大轮数 |
| `llm_error` / `parse_error` | LLM 调用失败 / 输出无法解析 |
| `sandbox_error` | 沙盒创建失败 |
| `error` | 其它异常 |

### 状态码
`200` 成功 · `401` token 错 · `429` 忙 · `500` 出错

---

## 六、成本结构（现在有两笔账）

| 支出 | 计费方式 | 谁收 |
|---|---|---|
| 沙盒 CPU/RAM | 按秒，沙盒活着就烧 | Tensorlake |
| LLM token | 每轮都调，轮数越多越贵 | 你的模型服务商 |

**省钱要点**：
1. `MAX_TURNS` 别设太大 —— 每多一轮 = 多一次 LLM 调用 + 多一段沙盒空转
2. 沙盒输出截断到 4000 字符，防止长输出把 token 烧爆
3. `BUDGET_MS` 是硬止损，到点必销毁

---

## 七、两个必须知道的边界

**1. 云函数本身有超时上限**
`BUDGET_MS` 默认 110s 是保守值。如果你的平台允许更长，可以调大；但**长任务本来就不适合一次 HTTP 请求跑完**，真要跑几分钟级任务得改异步架构。

**2. AI 生成的命令在真实 Linux 里跑**
沙盒是隔离的 Firecracker microVM，官方设计就是用来跑不可信代码的，不会伤到你的服务器。但别让它碰任何你塞进去的真实密钥——沙盒内能拿到的东西都随沙盒销毁，问题是**别主动传进去**。

---

## 八、验证顺序

1. 先发 `{"cmd": "echo hello"}` 确认沙盒通路（不走 LLM）
2. 再发 `{"task": "用 python 打印 1 到 5"}` 确认 LLM 循环
3. 看 `turns` 里每步的命令和输出是否符合预期
4. 若 `parse_error` 多，说明模型不按 JSON 回，换个模型或调低 temperature

---

## 九、鉴权：ORION_BASE_URL 白名单制（2026-10-19 v2）

> **绑定红线**：本服务**强制绑定 orion_agent_cloud，无独立运行模式**。
> 鉴权只有一条路（introspect 远端校验），`ORION_BASE_URL` 未配置即 503
> 锁死，orion 不可达时 fail-closed（401）。不设任何本地密钥比对或免鉴权
> 通道——脱离 orion 即无法使用，这是有意设计。

tl-agent **不设自有密钥**（APP_TOKEN 已取消），访问控制只有一个开关
`ORION_BASE_URL`：

| ORION_BASE_URL | 行为 |
|---|---|
| 已配置 | 请求必须携带有效 orion 令牌（JWT `eyJ` / 设备令牌 `dt_`），服务端调 orion `GET /api/auth/introspect` 远端校验（5s 超时），200 放行 |
| 未配置 | **服务锁定，一律 503**（无白名单不开放，杜绝免鉴权刷额度） |

**请求头**：客户端请同时带 `X-Orion-Token: Bearer <token>` 和
`Authorization: Bearer <token>`（EdgeOne 会把 `Authorization` 覆盖成平台
COS 签名，`X-Orion-Token` 是可靠通道；前端 app.js 已默认双发）。

**orion 侧**：需部署含 `GET /api/auth/introspect` 的版本（见 orion_agent_cloud
仓库 auth 路由，已随 2026-10-19 变更加入并重新构建 bundle）。

**验证顺序**：
1. orion 登录拿 JWT（或 `POST /api/auth/device-token` 换 `dt_`）
2. `curl -H "X-Orion-Token: Bearer <token>" https://<orion>/api/auth/introspect` → 应 200
3. tl-agent 调试台 Token 栏填同一令牌 → 任务应正常执行
4. 填一个伪造的 `dt_xxx` → 应 401
5. 删掉 `ORION_BASE_URL` 环境变量 → 应 503（服务锁定）

---

## 十、接入方式二：经 orion_agent_cloud 后端代理（2026-10-19）

除客户端直连外，orion_agent_cloud 新增代理接口，App 只需一套 orion 令牌
即可用上沙盒任务（无需感知 tl-agent 的地址与凭据）：

| 端点 | 说明 |
|---|---|
| `POST /api/sandbox/task` | orion requireAuth 后转发到本服务的 `/api/chat`，body `{task}` / `{cmd}`（可选 `maxTurns`），响应原样透传 |
| `GET /api/sandbox/info` | 返回 `{enabled}`，App 据此显隐入口 |

**orion 侧环境变量**：只需 `TL_AGENT_URL`（本服务根地址），**无需共享任何
密钥**——orion 后端把客户端令牌原样转发，本服务再向 orion introspect 闭环
校验（要求本服务 `ORION_BASE_URL` 指向同一 orion 实例）。上游 401/403 会被
orion 转成 502（不误导客户端重新登录）；429/500 原样透传。

**本服务零改动**：orion 后端以 `X-Orion-Token`/`Authorization: Bearer <客户端令牌>`
调用，落入白名单 introspect 通道，与直连场景完全一致。

## ⚠️ tensorlake 版本锁定说明（2026-10-19）

package.json 中 `tensorlake` **必须精确锁定 `0.5.0`**（不带 `^`）：

- 新版（约 0.5.1x 起）SDK 拆分为「壳包 + `@tensorlakeai/tensorlake` scoped 包」，
  scoped 包内部会 `import('@tensorlakeai/tensorlake/internal/native-worker')`
  自引用一个 `.cjs` 子路径。EdgeOne 云函数的打包/运行时无法解析这种
  scoped 自引用子路径，线上实测报错：
  `Cannot find module '@tensorlakeai/tensorlake/internal/native-worker'`，
  导致所有沙盒创建失败（finish=sandbox_error）。
- 0.5.0 为自包含纯 HTTP 实现（undici + ws），无 scoped 子包、无自引用，
  EdgeOne 上实测可用。SDK 对外 API（`Sandbox.create` / `sb.run` /
  `terminate` 等）与 `lib/sandbox.js` 的探测式调用完全兼容。
- 升级 SDK 前务必先在 EdgeOne 环境验证 native-worker 子路径可解析。

### undici 版本覆盖（2026-10-19 第二次修复）

锁定 0.5.0 后线上仍报 `Cannot read properties of undefined (reading 'bind')`：
tensorlake 0.5.0 声明的 `undici: ^8.1.0` 实际装到 8.x，而 **undici 8 要求
Node ≥ 22.19**，EdgeOne 云函数是 **Node 20** 运行时，不兼容。已在
package.json 用 `overrides` 把 undici 压到 `6.29.1`（Node ≥ 18 可用，
SDK 仅用 Agent / fetch / setGlobalDispatcher，v6 全部支持）。
**EdgeOne 控制台的 Node 版本升级到 22+ 前请勿移除此 overrides。**

### 内嵌补丁版 SDK（2026-10-19 第三次修复，最终方案）

锁定 0.5.0 后 API 又报 422：`ephemeral_disk_mb: unknown field`——现行
Tensorlake API 已把该字段改为 `disk_mb`，而 0.5.0 是硬编码旧字段（且
根本不读调用方的 diskMb）。0.5.140 虽用新字段但引入 grpc 依赖与
native-worker 惰性自引用，风险大。

**最终方案**：把 tensorlake 0.5.0 的 `dist/index.js`（166KB，自包含）
内嵌为 `cloud-functions/lib/tensorlake-0.5.0-patched.mjs`，仅补丁一处：
创建请求 `ephemeral_disk_mb` → 按调用方 `diskMb` 条件发送 `disk_mb`。
- `lib/sandbox.js` 改为 `import('./tensorlake-0.5.0-patched.mjs')`
- package.json 只保留 `undici@6.29.1`（精确锁定）+ `ws@^8.20.0`，
  不再依赖 npm 上的 tensorlake 包
- 本地冒烟：模块加载 OK，Sandbox.create 到达 API（假 key 返回 403，
  证明请求体已过 API 校验层）
