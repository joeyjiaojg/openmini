# OpenMini Windows 免安装版

和 Android 版同一套 host 页面、同一套 zip 应用格式，做成 Windows 绿色版：**解压即用，不写注册表，默认不预装任何应用**。

## 下载使用

从 [Releases](https://github.com/joeyjiaojg/openmini/releases) 下载 `OpenMini-Windows-v1.0.0-portable.zip`，解压到任意目录（U 盘也行），双击 `OpenMini.exe`。

- 首次启动是空盒子，在「应用市场」里点安装即可添加应用
- 应用和存档都在 exe 同级 `data/` 下，拷走 `data/` 就是搬走全部应用和存档
- 应用内按 `Esc` 或 `Alt+←` 回到盒子；点图标打开，长按可删除
- 也可以把 zip 应用包直接装进来：「＋ 装一个应用」→「本地文件」

## 技术实现

用 Electron 做运行时（原生 WebView2/Chromium），复用 `android/app/src/main/assets/host/` 的同一套启动器页面：

| 层 | Android | Windows |
|---|---|---|
| 运行时 | 系统 WebView | Electron 内置 Chromium |
| 启动器 origin | `https://host.apps.local` | `om://host.apps.local` |
| 应用 origin | `https://<id>.apps.local` | `om://<id>.apps.local` |
| 桥接通道 | `prompt('__om__…')` | preload 注入 `window.__om.call` |
| 数据目录 | `files/apps/` + WebView 存档 | `data/apps/` + 各 origin 的 localStorage |

两者都用「不同 hostname = 不同 origin」做存档隔离；升级同 id 应用只替换包目录，存档不丢。

`src/main.js` 实现桥接能力：应用列表、市场拉取（gh-proxy 加速）、zip 下载/校验/安装（zip-slip 防护、40MB 限制、原子替换）、卸载、打开应用窗口、外部链接交系统浏览器。`src/host/` 是 host 页面副本，只把桥接调用改成双通道兼容。

## 从源码打包

```bash
cd windows
npm install
node build-portable.js     # 输出到 ../dist/OpenMini-Windows-v1.0.0-portable.zip
```

打包产物约 130MB（Electron 运行时占大头），解压后 `data/` 首次运行自动生成。

## 端到端测试

测试脚本用 CDP 连 Electron，覆盖：零预装、市场真实加载（7 个应用）、从市场真实下载安装、独立 origin 打开、localStorage 可写、棋盘渲染、卸载、URL 不跑飞 —— 16/16 通过。
