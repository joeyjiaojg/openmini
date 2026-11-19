# 应用包格式（OpenMini Package）

一个应用包就是一个普通 zip，后缀随意（推荐 `.zip`）。OpenMini 解开它，放到
`files/apps/<id>/`，然后用 `https://<id>.apps.local/` 提供服务。

## 1. 目录结构

```
your-app.zip
├── manifest.json        ← 必须在根目录
├── index.html           ← 入口（entry 可改）
├── icon.png             ← 可选
└── ...                  ← 任意静态资源，保持相对路径互相引用即可
```

也接受「只有一层子目录」的形态：直接把文件夹右键压缩得到的 zip 里通常是这样，
OpenMini 会自动剥掉那层目录。

```
your-app.zip
└── my-app/
    ├── manifest.json
    └── index.html
```

## 2. manifest.json

```json
{
  "id": "demo",
  "name": "弹珠屏保",
  "version": "1.0.0",
  "versionCode": 1,
  "icon": "icon.png",
  "entry": "index.html"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 应用标识。正则 `[a-z0-9][a-z0-9_-]{0,39}`。决定虚拟域名 `<id>.apps.local` 和存档命名空间。`host` 为启动器保留，不可使用 |
| `name` | ✅ | 列表里显示的名字（中文没问题，UTF-8） |
| `version` | 建议 | 展示用版本号，如 `1.8.0` |
| `versionCode` | 建议 | 整数，仅展示 |
| `icon` | 可选 | 包内相对路径，建议 192×192 PNG/WebP。缺省时显示首字母占位 |
| `entry` | 可选 | 入口文件，默认 `index.html` |

## 3. 运行时约定

- **技术栈**：就是网页。HTML/CSS/JS 任意，不需要打包成单文件，也不需要 `file://` 那套限制。
- **存储**：`localStorage` / `IndexedDB` 都可用，命名空间是该应用的 origin，天然与其他应用隔离。升级包不会清空。
- **网络**：可以 `fetch` 外部接口（宿主已开 cleartext，http 也能访问）。跨域规则与浏览器一致。
- **兼容性**：跑在系统 WebView 上，老设备可能很旧 —— 稳妥起见按 ES5 写（不用箭头函数 / `let` / 模板字符串 / `Promise` / `fetch` 之外的现代 API，或自行 polyfill）。
- **不要用**：`history` / `location` / `top` / `name` 作为 JS 顶层全局变量名，会与 `window` 只读属性冲突导致脚本整体不执行。
- **全屏**：应用页面占满 WebView，没有系统栏内边距，请自己用 `env(safe-area-inset-*)` 处理刘海屏。
- **返回键**：按返回会直接回到启动器，应用内如果有多层页面想拦截，需要自己接入宿主返回逻辑（见 `android/app/src/main/assets/host/host.js` 的 `__onHostBack`）。

## 4. 校验与限制

| 项 | 值 |
|---|---|
| 单包解压后大小 | ≤ 40 MB |
| 路径 | 拒绝 `..`、绝对路径、盘符（zip-slip 防护） |
| 条目数 | 不限制（但体积受限） |
| 签名 | 无。装进来的包被完全信任，请只装自己来源的包 |

安装过程是原子的：解压到 `cache/stage` 校验通过后才替换旧目录，中途失败不会毁掉已装版本。

## 5. 升级

同 `id` 再装一次就是覆盖升级：

- 文件全部替换
- `localStorage` / `IndexedDB` / Cookie **保留**（存在 WebView 数据区，不在包目录）
- 如果换了 `id`，等于装了一个新应用，旧应用和旧存档都还在

## 6. 打包

```bash
# 从 apps/demo 打包，读目录里的 manifest.json
python tools/make-pkg.py apps/demo

# 用命令行覆盖字段
python tools/make-pkg.py apps/demo --version 1.1.0 --version-code 2 --name 弹珠屏保

# 指定输出（比如直接放进 APK 内置包目录）
python tools/make-pkg.py apps/xiangqi -o android/app/src/main/assets/apps/xiangqi.zip
```

打包时自动跳过 `.git`、`node_modules`、`__MACOSX`、`tools/` 和隐藏文件。

手工打包也可以：只要 zip 根目录有 `manifest.json` 和入口文件，怎么压都行。
