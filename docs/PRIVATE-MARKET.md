# 私有市场（加密仓）

> 面向：需要「带第三方接口配置」的应用，只能自己用、不能公开分发。

公开市场（`openmini-market`）只放不含第三方接口的包。像音乐盒这种依赖外部音源解析的应用，
包本身没什么，真正敏感的是**接口地址、token 与榜单快照**。私有市场把这两样一起加密，做成授权分发：

```
明文源（只在本机）                 私有仓 / 密文镜像                  手机上的小盒子
catalog.json ─┐                  meta.json（盐、迭代次数）          ① 输入账号口令
apps/*.zip  ──┴─ vault.py pack → catalog.enc, apps/*.enc ──拉取──→ ② 本机派生密钥
                                                                  ③ 解密 catalog
                                                                  ④ 解密并校验 zip → 安装
                                                                  ⑤ 应用向宿主索取自己的配置
```

## 1. 加密方案

| 项 | 取值 |
|---|---|
| KDF | PBKDF2-HMAC-SHA256，`account + 0x1F + password`，16B 随机盐，200000 次 |
| 加密 | AES-256-GCM，每文件独立 12B nonce，128-bit tag |
| AAD | `"OMV1|" + 文件路径` —— 改文件名或换文件内容都会解密失败 |
| 文件格式 | `"OMV1" \| nonce(12) \| 密文+tag` |
| 清单 | `catalog.json`：`apps[]`（id/版本/大小/sha256/blob 路径）+ `cfg{}`（按应用 id 下发的配置） |

口令不在任何仓库里；仓库里只有 `meta.json` 的盐与迭代次数。**没有口令，仓库全文只是一堆随机字节。**

## 2. 宿主侧实现（`Vault.java`）

- `restore()`：勾过「记住登录」时，启动后台静默恢复会话（密钥存 `SharedPreferences`，仅本机）
- `unlock(account, password, remember)`：拉 `meta.json` → 派生密钥 → 解密 `catalog.enc` → 缓存明文清单
- `install(id)`：拉 `apps/<hash>.enc` → 解密 → **校验 sha256** → `AppStore.install()`
- `lock()`：清内存密钥 + 清记住的会话
- `cfgFor(appId)`：只返回该应用自己那份配置

取数通道两条，编译期可切：

1. `PRIVATE_TOKEN` 为空（默认）→ 走公开**密文镜像** `joeyjiaojg/openmini-vault`；
2. 填一个只读（Contents: Read）、只授权 `openmini-market-private` 的 fine-grained PAT → 走 GitHub API 直读私有仓。

镜像只含 `.enc`，无密钥不可读；想「连密文都不公开」就填 token 重新打包，并删掉镜像仓。

## 3. 应用侧：`/__om__/vault.json`

应用不能调用宿主桥（桥只认 `host.apps.local`）。授权配置走**同源虚拟路径**：

```
GET https://music.apps.local/__om__/vault.json
→ 已解锁且该应用在清单里配过：{"ok":true,"app":"music","cfg":{…}}
→ 未解锁 / 没配过：            {"ok":false,"msg":"locked"}
```

- 由 `MainActivity.intercept()` 拦截，返回 `application/json`、`no-store`
- 只给「应用自己」那份：`vault.cfgFor(sub)`，A 应用拿不到 B 应用的配置
- 应用包里**不含任何接口地址**，拿不到配置就只能跑本地功能（音乐盒 = 纯本地：已缓存 + 手动直链）

这条设计的好处：即使旧版本包被翻出来，包里也没有可用的接口；授权是运行时按设备状态判定的。

## 4. 维护流程

工具在 `box/tools/vault.py`，私有仓 `openmini-market-private` 里也放了一份 `tools/vault.py`（方便在别处 checkout 后直接用）。

```bash
# 1. 改明文源（本机，不进仓库）
D:/WorkBuddyData/openmini-vault-src/catalog.json      # 应用清单 + cfg
D:/WorkBuddyData/openmini-vault-src/apps/*.zip        # 应用包

# 2. 打包加密
python box/tools/vault.py pack --src <明文源> --out <输出> \
    --account <账号> --password '<口令>' --updated 2026-11-26 \
    [--extra-user '名字:口令' ...]      # 想一次带多个账号就重复这个参数

# 3. 自检（会校验口令、sha256）
python box/tools/vault.py ls --dir <输出> --account <账号> --password '<口令>'
python box/tools/vault.py extract --dir <输出> --id music --out /tmp/m.zip \
    --account <账号> --password '<口令>'

# 4. 上传
openmini-market-private/vault/{meta.json,catalog.enc,apps/*.enc}
openmini-vault/{meta.json,catalog.enc,apps/*.enc}      # 密文镜像
```

换口令 = `vault.py passwd` 重写那一条密钥信封，或重新 `pack`；旧信封立刻失效。

## 5. 多账号（给家人/朋友开权限）

结构是「一个主密钥 + 每账号一份信封」，所以**加人不用重新加密任何应用包**：

```bash
# 加一个账号（只改 meta.json）
python box/tools/vault.py adduser --dir <输出> \
    --account joey --password '<你的口令>' \
    --new-account wife --new-password '<对方口令>'

# 改某人的口令（不动主密钥，包和别人的登录都不受影响）
python box/tools/vault.py passwd --dir <输出> \
    --account joey --password '<你的口令>' --target wife --new-password '<新口令>'

# 收回权限（立刻失效，对方下次拉清单/装包就失败）
python box/tools/vault.py deluser --dir <输出> \
    --account joey --password '<你的口令>' --target wife

# 看现在有谁
python box/tools/vault.py lsusers --dir <输出>
```

改完只上传 `meta.json`（私有仓 `vault/meta.json` + 镜像 `meta.json`）即可，`catalog.enc` / `apps/*.enc` 不用动。

`meta.json` 里的 `users[]` 每条是 `{name, salt, iter, wrap}`：`wrap` = 用该账号口令派生的 KEK 加密的主密钥，AAD 绑定账号名。所以：

- 仓里看得见「有几个账号、叫什么名字」，但**没有口令就解不开任何东西**；
- 想彻底连账号名都不露，就只能牺牲多账号（回到单账号仓，或把镜像仓删掉只走私有仓 API）。

**口令怎么发给对方**：直接口述/当面输，别写进仓库、别发群公告——那等于把仓的钥匙贴在门上。

## 6. 风险边界（务必知道）

- 这套方案降低的是「**向公众提供**」的风险：公开市场里没有这个应用，公网只有密文，密钥只在你手里。
- 它**不改变**音源本身的法律状态：你仍然是在没有授权的情况下收听/缓存他人作品。个人欣赏的合理使用空间见《著作权法》第 24 条，但**不要传播缓存文件、不要公开分享直链**。
- 仓库私有 + 口令 + 单设备使用，是「个人使用」这条线上能做到的最保守形态；真要彻底干净，只有用正版会员服务。
