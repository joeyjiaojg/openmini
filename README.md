# 小游盒（XiaoYou Box）

一个 **104KB** 的「小程序宿主」APK：装一次，以后所有小游戏/小应用都打成 **zip 包**装进盒子，
不用重新打包 APK、不用过任何应用市场审核。自用、发朋友用。

## 它解决什么问题

普通 WebView 壳 APK（比如楚汉象棋那个）每次改游戏都要重新打包、重新安装。
小游盒把「运行时」和「内容」拆开：

- APK 只保留启动器 + WebView 运行时（约 60KB）
- 每个游戏是一个 zip 包（含 `manifest.json`），装进盒子后独立运行
- 每个应用跑在独立虚拟域名 `https://<id>.apps.local` 上，**origin 不同 = localStorage 存档天然隔离**，
  而且升级覆盖目录不影响存档（存档在 WebView 数据里，不在包目录里）

## 三种装包方式

| 方式 | 适用场景 |
|------|----------|
| 粘贴链接安装 | 把 zip 丢到 GitHub Release / 任意直链，朋友粘链接就装 |
| 手机选 zip 文件 | 微信/QQ 收到 zip 后存到手机，从盒子里选；装过一次后直接点 zip 文件也能装（已注册 `application/zip` 打开方式） |
| 局域网上传 | 盒子里开启通道，电脑浏览器打开 `http://<手机IP>:8089` 拖 zip 进去，开发调试最方便 |

## 应用包格式

一个 zip，根目录直接放 `manifest.json` + 入口 + 资源：

```json
{
  "id": "xiangqi",
  "name": "楚汉象棋",
  "version": "1.8.0",
  "versionCode": 9,
  "icon": "icon.png",
  "entry": "index.html"
}
```

- `id`：小写字母数字 `-` `_`，最长 40，决定虚拟域名和存档命名空间
- `entry`：默认 `index.html`
- 同 id 重装 = 覆盖升级，存档保留
- zip 支持「根目录」或「唯一一层子目录」（直接把文件夹压缩了也能装）

打包脚本：

```bash
python tools/make-pkg.py apps/xiangqi -o android/app/src/main/assets/apps/xiangqi.zip
```

放进 `android/app/src/main/assets/apps/*.zip` 的包会在**首次启动**时自动安装（只做一次，
用户删掉不会复活）。

## 目录结构

```
box/
  android/                 # Gradle 工程（com.xiaoyou.box）
    app/src/main/java/com/xiaoyou/box/
      MainActivity.java    # WebView + 虚拟域名拦截 + JS 桥 + 返回键
      AppStore.java        # 包仓库：列表/安装/升级/卸载/内置播种
      MiniServer.java      # 局域网 HTTP 服务（PUT 上传，免 multipart 解析）
    app/src/main/assets/host/   # 启动器页面（index.html / style.css / host.js / lan.html）
    app/src/main/assets/apps/   # 内置应用包（.zip）
  apps/                    # 应用包源码（xiangqi、demo）
  tools/make-pkg.py        # 目录 → 应用包
  dist/                    # 打包产物
```

## 构建

```bash
python <skill>/scripts/build_apk.py --project android \
  --sdk-dir <sdk路径> --output 小游盒-v1.0.apk
```

产物约 104KB，minSdk 21。

## 已在模拟器验证过的链路

- 内置包自动安装；列表渲染（图标/名称/版本）
- 打开应用、游戏内交互、AI 应手、返回键回启动器
- 链接安装升级：象棋 v1.8.0 → v1.8.1，升级后「继续上次对局」还在
- 文件选择器安装第二个应用；多应用共存
- 局域网 PUT 上传 + 启动器自动刷新
- 长按删除应用

## 技术要点（踩坑记录）

- **每应用一个子域名**而不是 `WebViewAssetLoader` 的单域名：单域名下所有 app 共享
  localStorage，存档会串；子域方案用 `shouldInterceptRequest` 手动拦截
  `https://<id>.apps.local/*`，40 行搞定，不引 AndroidX。
- 走 `https://` 虚拟域名还白赚两件事：不用再内联 JS（`file://` 时代的 Script error 掩码问题
  消失），报错有真实行号；页面是安全上下文，WebAudio/clipboard 等 API 可用。
- Java → JS 只能 `evaluateJavascript`（异步），JS → Java 走 `@JavascriptInterface`
  同步返回；安装类耗时操作放后台线程，结果通过回调注入页面。
- 装包安全：解压防 zip-slip（canonicalPath 校验）、40MB 上限、id 白名单正则、
  不放开 `setAllowFileAccess`，第三方包读不到手机文件。
- 局域网上传故意用 `PUT + 原始二进制`，服务端几十行就写完；浏览器端 `XMLHttpRequest`
  自带上传进度。
- 测试注意：输入法弹出会改变 Web 页面布局坐标，`input tap` 前先 `keyevent 4` 收键盘或用
  `uiautomator dump` 拿真实 bounds（Web 内元素也会出现在 dump 里）。
- 沙箱/CI 里 adb reverse 的监听端口宿主侧连不上时，可在模拟器内用 toybox `nc` 自测
  HTTP 服务。
