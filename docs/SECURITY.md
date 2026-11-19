# 安全模型（Security）

小盒子的定位是「自用 + 发朋友」的本地宿主，不是应用商店。这份文档说清楚：
**谁是不可信的、防线在哪、哪些威胁明确不防**。安全改动都以红队实测验证过
（v1.1.0，用恶意测试包 + 无 PIN 上传实测，见文末）。

## 威胁模型

| 主体 | 信任级别 | 说明 |
|---|---|---|
| 宿主 APK 自己 | 可信 | 只信任 `assets/apps/` 里随包分发的内置包 |
| 用户本人 | 可信 | 用户主动粘贴的链接视为用户决策 |
| **装进来的应用包** | **完全不可信** | 任何人发你的 zip，代码都会在你的盒子里执行 |
| **局域网里的其它设备** | **完全不可信** | 同一 Wi-Fi 下任何设备都可能尝试上传 |
| 手机上的其它 App | 低度可疑 | 可能通过 VIEW intent 递包进来 |

核心原则：**包内容不因为"能被装进来"而获得任何宿主能力**。装进来的应用只是一个
普通网页，能做的只有网页本身能做的事（自己的 origin、自己发起的网络请求）。

## 防线清单

### 1. JS 桥按 origin 鉴权（最关键的一条）

宿主能力（列出/安装/删除应用、开局域网服务）都在一个 Java 桥里。
**没有用 `addJavascriptInterface`**——那个机制会把接口注入到 WebView 里的所有
frame，包括装进来的应用页面和它们加载的任何远程 iframe。

桥改走 `WebChromeClient.onJsPrompt`：该回调携带**发起调用的 frame 的 URL**，
Java 侧校验必须是 `https://host.apps.local` 才受理，否则返回 `{"ok":false,"msg":"forbidden"}`。

- 装进来的应用调用桥 → 一律 forbidden
- 应用想用 `prompt()` 弹假对话框钓鱼 → 直接 cancel，用户看不到任何弹窗

### 2. 导航锁定

WebView 只加载真实存在的 `*.apps.local` 页面（启动器 + 已装应用的入口）。

- 外部 http/https 链接（应用里点广告、`location.href` 跳转）→ 交给系统浏览器，
  WebView 内不加载 —— 浏览器里没有宿主桥，也没有存档
- `javascript:`、`intent:`、`file:`、`content:` scheme → 直接拒绝
- 子 frame 的任何外部加载 → 拒绝

### 3. 启动器防注入

包 manifest 的 `name` / `icon` 是攻击者可控字段：

- 启动器渲染全部走 `createElement` + `textContent`，**不用 innerHTML 拼接**，
  `name: "Evil<svg onload=alert(1)>"` 只会显示为文字
- `icon` / `entry` 必须匹配 `[A-Za-z0-9._/-]` 且不得含 `..`，否则字段被丢弃/安装失败
- 启动器响应带 CSP：`script-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'`，
  即使有漏网的内联脚本也无法执行或外带数据

### 4. 包校验

- `id` 白名单 `[a-z0-9][a-z0-9_-]{0,39}`，`host` 为保留字（不允许抢占启动器域名）
- zip 解压：canonical path 防 zip-slip、单包解压总量 ≤ 40MB、条目数 ≤ 2000、
  路径长度 ≤ 200、拒绝隐藏文件（`install` 后 WebView 侧也拒绝 `.开头` 的请求路径）
- `name` 去控制字符、限长 40
- 每个包记录 `sha256` 与安装来源（builtin / url:host / picker / lan），存入
  `pkgmeta`，供事后审计
- 外部 App 通过 VIEW intent 递包 → **必须经过用户确认对话框**才安装

### 5. 局域网通道

这是唯一对外监听的口子，做了四层：

- 每次开启生成 **6 位随机 PIN**（SecureRandom），完整地址形如
  `http://192.168.x.x:8089/123456/`，路径里没有正确 PIN → 403（连页面都不给）
- 只接受内网/链路本地来源地址（`isSiteLocalAddress`），公网来源直接断开
- **5 分钟无请求自动关闭**，不长期监听
- 上传仍走 AppStore 的全套校验（同第 4 条）

### 6. WebView 与系统面

- `allowBackup=false`：adb backup / 云备份拿不走应用数据与包目录
- `setAllowFileAccess(false)`、`setAllowContentAccess(false)`、
  file-URL 文件访问全部关闭；`setSavePassword(false)`；禁用定位
- Safe Browsing 开启（API 26+）
- 存档隔离：每应用一个虚拟域名 origin，应用之间读不到彼此的 localStorage，
  也读不到启动器的（启动器里没有任何用户敏感数据，只有包列表）

## 明确不防的（诚实清单）

| 威胁 | 现状 | 缓解建议 |
|---|---|---|
| **http 链接下载被中间人替换** | 链接安装支持 http（为了兼容网盘/局域网直链），传输不加密不验签 | 尽量用 https 直链或 GitHub Release；重要包对比 sha256（安装结果里有） |
| **用户主动安装恶意包** | 技术上拦不住"你自己同意装的代码做网页能做的事"（耗电、挖矿、展示钓鱼内容） | 只装信任来源的包；长按可随时删除 |
| **包签名 / 防替换升级** | 未实现。同 id 重装总是覆盖，LAN 上传者若有 PIN 就能替换应用 | 路线图：manifest 签名 + 首装锁定公钥（TOFU）；现阶段 PIN 已挡住局域网匿名替换 |
| **WebView / 系统 0day** | 依赖系统 WebView 版本 | 系统保持更新；老设备风险自担 |
| **应用滥用网络** | 应用可以 fetch 任意 https 接口（这是网页的正常能力） | 想限制就在路由器层控；不给应用配任何凭据 |

## 给应用作者的建议

- 应用里不要内嵌密钥/凭据 —— 包是明文 zip，拿到包就能读
- 不要在应用里放 `target="_blank"` 之外的外部跳转，外跳会被送出宿主
- 想持久化就用自己的 origin（localStorage / IndexedDB），跨应用不共享

## 验证记录（v1.1.0 红队实测）

| 攻击 | 结果 |
|---|---|
| 应用内取 `window.Box` | `undefined` |
| 应用内调桥 apps / serverStart / remove | `forbidden` |
| 应用内 `prompt()` 钓鱼 | 被静默取消，无弹窗 |
| 应用 `location.href` 跳外站 | 转交系统浏览器，WebView 未加载 |
| manifest `name` 塞 HTML/SVG | 原样显示为文本，无执行 |
| `icon: 'x" onerror="fetch(1)'` | 字段被丢弃，无注入 |
| zip 条目 `../escape.txt` | 安装失败（zip-slip 拦截） |
| zip 塞 3000 个条目 | 安装失败（条目数上限） |
| 无 PIN 向 `PUT /upload` | `403 Forbidden` |
| 带 PIN 上传（同一 Wi-Fi 模拟） | 正常安装，sha256/来源入档 |

## 内置应用安全扫描（v1.1.2，血战到底麻将）

逐文件扫描 `apps/mahjong/`（rule/ai/game/ui/voice/boot + index.html + manifest）：

| 检查项 | 结论 |
|---|---|
| `innerHTML` 插值（14 处） | ✅ 已全部加 `esc()` 转义。插值源（玩家名/牌名/番型名/事件）当前均为内部常量，转义属纵深防御 |
| `eval` / `new Function` / 内联事件 / `document.write` | ✅ 无 |
| 外部网络（fetch / XHR / WebSocket / window.open / 外跳） | ✅ 无，`connect-src 'none'` 收口 |
| `localStorage` | ✅ 唯一键 `mj_level`，`parseInt` + 白名单 0/1/2，无注入面 |
| 语音资源路径 | ✅ 固定前缀 `voice/` + 内部白名单名（p0-p26 / a_*），无路径拼接注入 |
| `data-tile` 事件委托 | ✅ `parseInt` + `isNaN` 拒绝，仅数字进入游戏逻辑 |
| 存储隔离 | ✅ 每包独立 origin，localStorage 天然隔离 |
| 游戏逻辑滥用 | ✅ 人类出牌过缺门硬校验（v1.0.2），AI 决策无用户输入 |
| 定时器 | ✅ `later()` 带 over 保护，restart 全量清理，无重复触发面 |
| **页面 CSP** | ⚠️ → ✅ v1.1.2 修复：此前宿主只给启动器加 CSP，应用包页面裸奔。宿主新增 `manifest.csp` 可选声明（`cspOf()` 缓存 + 字符白名单防响应头注入），麻将声明严格 CSP：脚本限 self、connect-src none、media self |

配套宿主改动（v1.1.2）：`AppStore.cspOf()` + `MainActivity` 应用资源分支按 HTML 响应附加 CSP 头与 `Referrer-Policy: no-referrer`。

## 上报漏洞

发现安全问题请开 [issue](https://github.com/joeyjiaojg/openmini/issues) 或私聊仓库作者，
请勿在公开 issue 里贴可直接利用的细节。
