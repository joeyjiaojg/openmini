# OpenMini 小盒子 · Windows / Linux 免安装版

和 Android 版同一套 host 页面、同一套 zip 应用格式，做成桌面绿色版：**解压即用，不写注册表，默认不预装任何应用**。

| 系统 | 发布包 | 版本 |
|---|---|---|
| Windows 7+ (x64) | `OpenMini-Windows-v1.1.0-portable.zip` | v1.1.0 |
| Debian / Ubuntu (x86_64) | `OpenMini-Linux-v1.0.0-x64.tar.gz` | v1.0.0 |

两个包都从 [Releases](https://github.com/joeyjiaojg/openmini/releases) 下载。

## 下载使用

### Windows

解压 `OpenMini-Windows-v1.1.0-portable.zip` 到任意目录（U 盘也可以），双击 `OpenMini.exe`。

### Linux

```bash
tar -xzf OpenMini-Linux-v1.0.0-x64.tar.gz
cd OpenMini-Linux
./install-desktop.sh      # 推荐：加入应用菜单 + 桌面图标，之后可双击
```

之后在应用菜单搜索「小盒子」，或双击桌面的 OpenMini 图标。`install-desktop.sh` 会生成带绝对路径的 `.desktop` 并标记为可信，避免 GNOME 拦截「未信任启动器」。也可以直接 `./OpenMini` 运行；若双击 `OpenMini.desktop` 被拦，右键选「允许启动」。

若提示缺库（多数桌面版已自带）：

```bash
sudo apt install -y libgtk-3-0 libnss3 libasound2 libxss1 libgbm1 libdrm2 libxkbcommon0
```

绿色版无法给 `chrome-sandbox` 设置 setuid root，程序会自动降级为 `--no-sandbox`。需要完整沙箱时执行 `sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox`，程序检测到 setuid 位会自动恢复沙箱。

### 通用操作

- 首次启动是空盒子，在「应用市场」里点安装即可添加应用
- 应用内按 `Esc` 或 `Alt+←` 回到盒子；点图标打开，长按可删除
- 也可以把 zip 应用包直接装进来：「＋ 装一个应用」→「本地文件」

## 数据放在哪（Windows / Linux 一致）

**默认在用户目录 `~/.openmini/`**：

- Windows：`C:\Users\<你的用户名>\.openmini\`
- Linux：`/home/<你的用户名>/.openmini/`

所以程序装在只读目录（如 `C:\Program Files`、`/opt`）也能正常使用。应用、存档和设置都在里面，拷走这个目录就是完整迁移。

三种覆盖方式：

| 方式 | 用法 | 数据位置 |
|---|---|---|
| 默认 | 直接启动 | `~/.openmini/` |
| 便携模式 | 在 `OpenMini.exe` / `OpenMini` 旁边建一个空的 `portable.txt` | 程序目录 `data/`（U 盘拷走整个文件夹） |
| 自定义 | 设置环境变量 `OPENMINI_DATA=/path/to/data` | 指定目录 |

从 v1.0.x 升级时，程序目录里旧的 `data/` 会在首次启动**自动迁移**到 `~/.openmini/`（跨磁盘自动降级为复制后删除），存档不丢。开发模式（`npm start`）只用 `windows/data-dev/`，不碰真实数据。

## 技术实现

用 Electron 做运行时（原生 Chromium），复用 `android/app/src/main/assets/host/` 的同一套启动器页面：

| 层 | Android | Windows / Linux |
|---|---|---|
| 运行时 | 系统 WebView | Electron 内置 Chromium |
| 启动器 origin | `https://host.apps.local` | `om://host.apps.local` |
| 应用 origin | `https://<id>.apps.local` | `om://<id>.apps.local` |
| 桥接通道 | `prompt('__om__…')` | preload 注入 `window.__om.call` |
| 数据目录 | `files/apps/` + WebView 存档 | `~/.openmini/`（可由 `paths.js` 覆盖） |

两者都用「不同 hostname = 不同 origin」做存档隔离；升级同 id 应用只替换包目录，存档不丢。

`src/main.js` 实现桥接能力：应用列表、市场拉取（gh-proxy 加速）、zip 下载/校验/安装（zip-slip 防护、40MB 限制、原子替换）、卸载、打开应用窗口、外部链接交系统浏览器。`src/paths.js` 统一解析数据目录并负责旧数据迁移。`src/host/` 是 host 页面副本，只把桥接调用改成双通道兼容。主进程 `window.__om.meta` 返回 `version` / `platform` / `dataDir` / `dataMode`，便于自动化校验。

## 从源码打包

```bash
cd windows
npm install
node build-portable.js        # → ../dist/OpenMini-Windows-v1.1.0-portable.zip
python build-linux.py         # → ../dist/OpenMini-Linux-v1.0.0-x64.tar.gz（需 curl + Python 3）
```

Linux 打包用 tar.gz 而不是 zip，是为了保留可执行位；Electron linux-x64 运行时会缓存在 `.cache/`，首次构建需联网下载（约 100MB）。两者产物都约 110–130MB，大头是 Electron 运行时，**默认零预装应用**。

## 端到端测试

- Windows v1.1.0：19/19 通过（含市场加载、真实安装、origin 隔离、卸载、默认目录 / 迁移 / 便携 / 自定义四种数据模式）
- Linux v1.0.0：52/52 静态校验通过（tar 权限与 ELF、`.desktop` Exec 路径模拟、代码一致性、零预装）

测试脚本用 CDP 连 Electron，覆盖真实市场下载安装、独立 origin 打开、localStorage 可写、棋盘渲染和外链不跑飞。
