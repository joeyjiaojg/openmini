package com.openmini.host;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashMap;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;

/**
 * 单 Activity 宿主：内置 WebView 只认 *.apps.local 这一组虚拟域名。
 * 启动器（host.apps.local）负责列表和装包，每个游戏跑在 <id>.apps.local，
 * 因为域名不同 = origin 不同，localStorage 天然隔离，存档互不干扰。
 *
 * 安全模型：
 *  - 不给任何页面注入 JS 接口。JS→Java 走 prompt() 通道，且只接受来自
 *    https://host.apps.local 这个 origin 的调用 —— 装进来的应用页面即使
 *    主动调 prompt 也只会拿到 forbidden。
 *  - WebView 只在 *.apps.local 内部导航；外部链接交给系统浏览器（不带宿主能力）。
 *  - 启动器响应带 CSP，禁止内联脚本与 iframe，配合启动器渲染全部走
 *    createElement（无 innerHTML 拼接），挡住包 manifest 的注入。
 */
public class MainActivity extends Activity {

    static final String DOMAIN = ".apps.local";
    static final String HOST = "host";
    static final String ID_RE = "[a-z0-9][a-z0-9_-]{0,39}";
    /** 应用向宿主索取赋能配置的虚拟路径（同源，只能取到自己那份） */
    static final String PART_VAULT = "__om__/vault.json";
    /** 应用侧的同源代理：给没有 CORS 头的公开接口兜底（只放行私有配置里的域名） */
    static final String PART_PROXY = "__om__/proxy";
    private static final String PROMPT_PREFIX = "__om__";
    private static final int REQ_PICK = 1001;
    private static final int REQ_INSTALL_UNKNOWN = 1002;

    /* 宿主自升级：检查 openmini 仓库 latest Release，从 APK 资产名解析版本。
     * tag（v1.5.0）是发布流水号，与 APK 版本（1.2.1）不同，不能拿来比较。 */
    private static final String SELF_UPDATE_API =
            "https://gh-proxy.org/https://api.github.com/repos/joeyjiaojg/openmini/releases/latest";
    static final String UPDATE_APK = "openmini-update.apk";
    private static final Pattern APK_VER = Pattern.compile("OpenMini-v(\\d+(?:\\.\\d+)*)\\.apk", Pattern.CASE_INSENSITIVE);

    /* 默认应用市场：小盒子启动后从这里拉最新 Release 的 zip 资产。
     * 走 gh-proxy 前缀，国内可直连；API 拿到的 browser_download_url 会再套一层前缀。 */
    private static final String MARKET_API =
            "https://gh-proxy.org/https://api.github.com/repos/joeyjiaojg/openmini-market/releases/latest";
    /* 市场应用补充元数据（名称/描述/分类/图标），拉取失败时降级为文件名解析，不影响安装。 */
    private static final String MARKET_CATALOG_API =
            "https://gh-proxy.org/https://raw.githubusercontent.com/joeyjiaojg/openmini-market/main/catalog.json";
    private static final String GH_PROXY = "https://gh-proxy.org/";

    private static final String CSP_LAUNCHER =
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' https: data:; connect-src 'self'; frame-src 'none'; "
            + "object-src 'none'; base-uri 'none'; form-action 'none'";

    private WebView webView;
    private AppStore store;
    private Vault vault;
    private MiniServer server;
    private String currentAppId = null;
    private long lastBackAt = 0;
    private volatile boolean overlayOpen = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        store = new AppStore(this);
        store.seedBuiltins();
        vault = new Vault(this, store);
        vault.restore();   // 记住登录的话，后台静默恢复会话
        server = new MiniServer(store, 8089);
        server.setListener(new MiniServer.Listener() {
            public void onInstalled(String json) {
                js("window.BoxUI&&BoxUI.onPickRefresh&&BoxUI.onPickRefresh()");
            }
        });

        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMediaPlaybackRequiresUserGesture(false);
        // 页面全部走虚拟域名，不需要任何本地文件访问能力
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setSavePassword(false);
        s.setSaveFormData(false);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(false);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            try {
                s.setSafeBrowsingEnabled(true);
            } catch (Throwable ignored) {
            }
        }
        webView.setBackgroundColor(0xFF14110E);
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        // 不注册 addJavascriptInterface：桥走 prompt 通道，按 origin 鉴权
        webView.setDownloadListener(null);

        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        setContentView(webView);
        // 转屏会重建 Activity（manifest 未声明 configChanges），
        // 重建时把正在用的应用捞回来，直接按新尺寸加载，不走主页
        String saved = b == null ? null : b.getString("omAppId");
        if (saved != null && !HOST.equals(saved) && saved.matches(ID_RE) && store.get(saved) != null) {
            currentAppId = saved;
            applyOrientation(store.get(saved));
            webView.loadUrl(url(saved, "/" + store.entryOf(saved)));
        } else {
            goHome();
        }

        handleViewIntent(getIntent());
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (currentAppId != null) outState.putString("omAppId", currentAppId);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleViewIntent(intent);
    }

    // ---------- 虚拟域名 ----------

    static String url(String sub, String path) {
        return "https://" + sub + DOMAIN + path;
    }

    private void goHome() {
        currentAppId = null;
        applyOrientation(null); // 回启动器一律恢复竖屏
        if (webView != null) webView.loadUrl(url(HOST, "/index.html"));
    }

    /** 按包 manifest 的 orientation 字段转屏：landscape/sensor 可选，默认竖屏。
     *  landscape 用「强制横屏」而不是 SENSOR_LANDSCAPE：真机开「自动旋转锁定」时
     *  传感器方向会被系统忽略，导致麻将这类横屏包打开还是竖屏。 */
    private void applyOrientation(JSONObject manifest) {
        String o = manifest == null ? "" : manifest.optString("orientation", "");
        try {
            if ("landscape".equalsIgnoreCase(o)) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE);
            } else if ("sensor".equalsIgnoreCase(o)) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
            } else {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
            }
        } catch (Exception ignored) {
        }
    }

    private void openApp(String id) {
        if (id == null || !id.matches(ID_RE) || HOST.equals(id)) {
            toast("应用不存在");
            return;
        }
        JSONObject m = store.get(id);
        if (m == null) {
            toast("应用不存在");
            return;
        }
        currentAppId = id;
        applyOrientation(m);
        webView.loadUrl(url(id, "/" + store.entryOf(id)));
    }

    private boolean inLauncher() {
        return currentAppId == null;
    }

    /** 调用方 URL 是否就是启动器页面（不是某个应用、也不是某个 iframe） */
    private static boolean isLauncherUrl(String u) {
        if (u == null) return false;
        Uri p = Uri.parse(u);
        String scheme = p.getScheme();
        String host = p.getHost();
        return scheme != null && "https".equalsIgnoreCase(scheme)
                && host != null && (HOST + DOMAIN).equalsIgnoreCase(host);
    }

    // ---------- 网络与导航 ----------

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            return intercept(req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            return handleNavigation(req.getUrl(), req.isForMainFrame());
        }

        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView v, String u) {
            return handleNavigation(Uri.parse(u), true);
        }
    }

    /**
     * 只有 *.apps.local 且包真实存在的页面可以在 WebView 里加载。
     * 其它 http/https 链接交给系统浏览器；javascript:、intent:、file: 一律拒绝。
     */
    private boolean handleNavigation(Uri u, boolean mainFrame) {
        if (u == null) return true;
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.US);
        String host = u.getHost() == null ? "" : u.getHost().toLowerCase(Locale.US);

        if ("about".equals(scheme)) return false;

        if (("https".equals(scheme) || "http".equals(scheme)) && host.endsWith(DOMAIN)) {
            if (!"https".equals(scheme)) return true;
            String sub = host.substring(0, host.length() - DOMAIN.length());
            if (HOST.equals(sub)) return false;
            if (!sub.matches(ID_RE)) return true;
            return store.get(sub) == null; // 应用不存在 → 拦掉
        }

        if (mainFrame && ("http".equals(scheme) || "https".equals(scheme))) {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, u);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                toast("已在浏览器打开外部链接");
            } catch (Exception ignored) {
            }
        }
        return true;
    }

    private WebResourceResponse intercept(Uri u) {
        String host = u.getHost();
        if (host == null || !host.endsWith(DOMAIN)) return null;
        String sub = host.substring(0, host.length() - DOMAIN.length());
        String path = u.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        if (path.indexOf('\0') >= 0 || path.contains("..") || path.contains("//")) return notFound();

        String rel = path.startsWith("/") ? path.substring(1) : path;

        /* 私有市场赋能配置：只下发给清单里配置过、且宿主已解锁的那个应用自己。
           没解锁 / 没配过 → 403 内容，应用自然降级为纯本地模式。 */
        if (PART_VAULT.equals(rel)) {
            JSONObject o = new JSONObject();
            String cfg = HOST.equals(sub) ? null : vault.cfgFor(sub);
            try {
                if (cfg != null) {
                    o.put("ok", true);
                    o.put("app", sub);
                    o.put("cfg", new JSONObject(cfg));
                } else {
                    o.put("ok", false);
                    o.put("msg", vault.unlocked() ? "no-config" : "locked");
                }
            } catch (Exception ignored) {
            }
            byte[] body;
            try {
                body = o.toString().getBytes("UTF-8");
            } catch (Exception e) {
                body = new byte[0];
            }
            WebResourceResponse vr = new WebResourceResponse("application/json", "UTF-8",
                    new ByteArrayInputStream(body));
            HashMap<String, String> vh = new HashMap<String, String>();
            vh.put("Cache-Control", "no-store");
            vh.put("X-Content-Type-Options", "nosniff");
            vr.setResponseHeaders(vh);
            return vr;
        }
        /* 同源代理：只有解锁后、且目标域名写在该应用私有配置的 proxyHosts 里才放行。
           默认 GET https；带 m=POST&b=<表单体> 时转发为受限 POST（体积 ≤16KB），
           供歌曲宝这类「换播放链接必须 POST」的接口使用。
           不跟随跳转、响应限 2MB —— 它不是通用爬虫通道。 */
        if (PART_PROXY.equals(rel)) {
            byte[] body;
            int code = 200;
            String reason = "OK";
            try {
                String cfg = HOST.equals(sub) ? null : vault.cfgFor(sub);
                if (cfg == null) throw new IOException(vault.unlocked() ? "no-config" : "locked");
                String target = u.getQueryParameter("u");
                if (target == null || !target.toLowerCase(Locale.US).startsWith("https://")) {
                    throw new IOException("只允许 https");
                }
                String th = Uri.parse(target).getHost();
                JSONArray allow = new JSONObject(cfg).optJSONArray("proxyHosts");
                boolean okHost = false;
                if (th != null && allow != null) {
                    for (int i = 0; i < allow.length(); i++) {
                        if (th.equalsIgnoreCase(allow.optString(i))) {
                            okHost = true;
                            break;
                        }
                    }
                }
                if (!okHost) throw new IOException("域名未授权");
                if ("POST".equals(u.getQueryParameter("m"))) {
                    String b = u.getQueryParameter("b");
                    byte[] payload = b == null ? new byte[0] : b.getBytes("UTF-8");
                    if (payload.length > 16 * 1024) throw new IOException("请求体过大");
                    body = proxyPost(target, payload);
                } else {
                    body = proxyGet(target);
                }
            } catch (Exception e) {
                code = 403;
                reason = "Denied";
                try {
                    body = new JSONObject().put("ok", false)
                            .put("msg", e.getMessage() == null ? "拒绝" : e.getMessage())
                            .toString().getBytes("UTF-8");
                } catch (Exception x) {
                    body = new byte[0];
                }
            }
            WebResourceResponse vr = new WebResourceResponse("application/json", "UTF-8", code, reason,
                    new HashMap<String, String>(), new ByteArrayInputStream(body));
            HashMap<String, String> ph = new HashMap<String, String>();
            ph.put("Cache-Control", "no-store");
            ph.put("X-Content-Type-Options", "nosniff");
            vr.setResponseHeaders(ph);
            return vr;
        }

        // 不让包读取隐藏文件（如 .git）
        for (String seg : rel.split("/")) {
            if (seg.startsWith(".")) return notFound();
        }

        WebResourceResponse r;
        HashMap<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");

        try {
            if (HOST.equals(sub)) {
                InputStream in = getAssets().open("host/" + rel);
                String mime = mimeOf(rel);
                r = new WebResourceResponse(mime, charsetOf(mime), in);
                headers.put("Content-Security-Policy", CSP_LAUNCHER);
                headers.put("Referrer-Policy", "no-referrer");
            } else {
                if (!sub.matches(ID_RE) || HOST.equals(sub)) return notFound();
                File base = store.dir(sub);
                File f = new File(base, rel);
                String baseCanon = base.getCanonicalPath() + File.separator;
                if (!f.getCanonicalPath().startsWith(baseCanon) || !f.isFile()) return notFound();
                String mime = mimeOf(rel);
                r = new WebResourceResponse(mime, charsetOf(mime), new FileInputStream(f));
                // 包可选声明自己的 CSP（manifest.csp），给装进来的代码再上一道枷锁
                String csp = store.cspOf(sub);
                if (csp != null && "text/html".equals(mime)) {
                    headers.put("Content-Security-Policy", csp);
                }
                headers.put("Referrer-Policy", "no-referrer");
            }
        } catch (Exception e) {
            return notFound();
        }

        r.setResponseHeaders(headers);
        return r;
    }

    /** 代理取数：GET、https、禁跳转、2MB 上限、伪装成普通浏览器（部分接口认 UA） */
    private static byte[] proxyGet(String urlStr) throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(18000);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) "
                            + "Chrome/120.0.0.0 Mobile Safari/537.36");
            c.setRequestProperty("Accept", "application/json,text/plain,*/*");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 2 * 1024 * 1024) throw new IOException("内容过大");
                out.write(buf, 0, n);
            }
            in.close();
            return out.toByteArray();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 受限 POST：仅当目标域名在 proxyHosts 白名单且请求体 ≤16KB 时由上面调用 */
    private static byte[] proxyPost(String urlStr, byte[] payload) throws IOException {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(18000);
            c.setInstanceFollowRedirects(false);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) "
                            + "Chrome/120.0.0.0 Mobile Safari/537.36");
            c.setRequestProperty("Accept", "application/json,text/plain,*/*");
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            c.setRequestProperty("X-Requested-With", "XMLHttpRequest");
            OutputStream os = c.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n, total = 0;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > 2 * 1024 * 1024) throw new IOException("内容过大");
                out.write(buf, 0, n);
            }
            in.close();
            return out.toByteArray();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(),
                new ByteArrayInputStream("404".getBytes()));
    }

    private static String mimeOf(String p) {
        String s = p.toLowerCase(Locale.US);
        if (s.endsWith(".html") || s.endsWith(".htm")) return "text/html";
        if (s.endsWith(".css")) return "text/css";
        if (s.endsWith(".js") || s.endsWith(".mjs")) return "application/javascript";
        if (s.endsWith(".json") || s.endsWith(".webmanifest")) return "application/json";
        if (s.endsWith(".png")) return "image/png";
        if (s.endsWith(".jpg") || s.endsWith(".jpeg")) return "image/jpeg";
        if (s.endsWith(".webp")) return "image/webp";
        if (s.endsWith(".gif")) return "image/gif";
        if (s.endsWith(".svg")) return "image/svg+xml";
        if (s.endsWith(".ico")) return "image/x-icon";
        if (s.endsWith(".mp3")) return "audio/mpeg";
        if (s.endsWith(".ogg") || s.endsWith(".oga")) return "audio/ogg";
        if (s.endsWith(".wav")) return "audio/wav";
        if (s.endsWith(".m4a")) return "audio/mp4";
        if (s.endsWith(".mp4")) return "video/mp4";
        if (s.endsWith(".ttf")) return "font/ttf";
        if (s.endsWith(".woff")) return "font/woff";
        if (s.endsWith(".woff2")) return "font/woff2";
        if (s.endsWith(".wasm")) return "application/wasm";
        if (s.endsWith(".txt") || s.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    private static String charsetOf(String mime) {
        if (mime.startsWith("text/") || mime.contains("json") || mime.contains("javascript")
                || mime.contains("svg")) return "UTF-8";
        return null;
    }

    // ---------- 与页面沟通 ----------

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            public void run() {
                if (webView != null) {
                    try {
                        webView.evaluateJavascript(code, null);
                    } catch (Exception ignored) {
                    }
                }
            }
        });
    }

    private void result(AppStore.Result r) {
        android.util.Log.i("box", "install result ok=" + r.ok + " msg=" + r.msg);
        js("window.BoxUI&&BoxUI.onResult(" + r.toJson() + ")");
    }

    private void progress(int pct) {
        js("window.BoxUI&&BoxUI.onProgress(" + pct + ")");
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            public void run() {
                try {
                    android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {
                }
            }
        });
    }

    /**
     * JS 桥。没有 addJavascriptInterface，改由 prompt() 触发；onJsPrompt 的 url 参数是
     * 发起调用的 frame 地址，因此可以做到「只有启动器能调用宿主能力」。
     */
    private class Chrome extends WebChromeClient {
        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                  JsPromptResult res) {
            if (message == null || !message.startsWith(PROMPT_PREFIX)) {
                // 应用页面想弹输入框？直接取消，避免它伪装成宿主向用户索要信息
                res.cancel();
                return true;
            }
            if (!isLauncherUrl(url)) {
                res.confirm("{\"ok\":false,\"msg\":\"forbidden\"}");
                return true;
            }
            String out;
            try {
                JSONObject req = new JSONObject(message.substring(PROMPT_PREFIX.length()));
                out = dispatch(req.optString("m", ""), req.opt("a"));
            } catch (Exception e) {
                out = "{\"ok\":false,\"msg\":\"bad request\"}";
            }
            res.confirm(out == null ? "" : out);
            return true;
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult res) {
            res.cancel();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult res) {
            res.cancel();
            return true;
        }
    }

    /** 在 UI 线程执行，只做轻量工作；耗时操作一律开线程 */
    private String dispatch(String m, Object arg) {
        String a = arg instanceof String ? (String) arg : (arg == null ? null : String.valueOf(arg));

        if ("apps".equals(m)) return store.listJson();

        // ---------- 私有市场（加密仓） ----------
        if ("vaultState".equals(m)) return vault.stateJson().toString();
        if ("vaultUnlock".equals(m)) {
            String u = "", pw = "";
            boolean rem = true;
            try {
                JSONObject p = new JSONObject(a == null || a.length() == 0 ? "{}" : a);
                u = p.optString("u", "");
                pw = p.optString("p", "");
                rem = p.optBoolean("remember", true);
            } catch (Exception ignored) {
            }
            vault.unlock(u, pw, rem, new Vault.Cb() {
                public void done(JSONObject o) {
                    js("window.BoxUI&&BoxUI.onVault(" + o + ")");
                }
            });
            return "";
        }
        if ("vaultLock".equals(m)) {
            vault.lock();
            return vault.stateJson().toString();
        }
        if ("vaultList".equals(m)) {
            vault.list(new Vault.Cb() {
                public void done(JSONObject o) {
                    js("window.BoxUI&&BoxUI.onVault(" + o + ")");
                }
            });
            return "";
        }
        if ("vaultInstall".equals(m)) {
            vault.install(a, new Vault.Progress() {
                public void pct(final int p) {
                    js("window.BoxUI&&BoxUI.onProgress(" + p + ")");
                }
            }, new Vault.Cb() {
                public void done(JSONObject o) {
                    js("window.BoxUI&&BoxUI.onResult(" + o + ")");
                }
            });
            return "";
        }

        if ("market".equals(m)) {
            loadMarket();
            return "";
        }
        if ("updateCheck".equals(m)) {
            checkSelfUpdate();
            return "";
        }
        if ("updateInstall".equals(m)) {
            installSelfUpdate();
            return "";
        }
        if ("meta".equals(m)) {
            JSONObject o = new JSONObject();
            try {
                o.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
                o.put("appId", currentAppId == null ? "" : currentAppId);
                o.put("lanRunning", server.isRunning());
                o.put("serverSocket", server.isRunning() ? server.url() : "");
            } catch (Exception ignored) {
            }
            return o.toString();
        }
        if ("installUrl".equals(m)) {
            installFromUrl(a);
            return "";
        }
        if ("pick".equals(m)) {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, REQ_PICK);
            } catch (Exception e) {
                toast("没有可用的文件选择器");
            }
            return "";
        }
        if ("remove".equals(m)) {
            removeApp(a);
            return "";
        }
        if ("open".equals(m)) {
            openApp(a);
            return "";
        }
        if ("home".equals(m)) {
            goHome();
            return "";
        }
        if ("back".equals(m)) {
            if (!inLauncher()) goHome();
            return "";
        }
        if ("serverStart".equals(m)) {
            JSONObject o = new JSONObject();
            try {
                String u = server.start();
                if (!server.isRunning()) throw new IOException("端口被占用");
                o.put("ok", true);
                o.put("url", u);
                o.put("pin", server.pin());
            } catch (Exception e) {
                try {
                    o.put("ok", false);
                    o.put("url", "");
                    o.put("msg", "开启失败，可能是端口被占用");
                } catch (Exception ignored) {
                }
            }
            return o.toString();
        }
        if ("serverStop".equals(m)) {
            server.stop();
            return "";
        }
        if ("setOverlay".equals(m)) {
            overlayOpen = "true".equals(a);
            return "";
        }
        if ("toastMsg".equals(m)) {
            if (a != null && a.length() <= 80) toast(a);
            return "";
        }
        return "{\"ok\":false,\"msg\":\"unknown\"}";
    }

    // ---------- 应用市场 ----------

    /** 拉取默认市场的 latest Release 资产列表，回调 window.BoxUI.onMarket(json)。
     *  只读取官方仓库的公开 Release；失败时返回 ok=false，页面降级到本地应用列表。 */
    private void loadMarket() {
        new Thread(new Runnable() {
            public void run() {
                String body;
                try {
                    // 先取补充元数据（名称/描述/分类/图标），失败不影响主流程。
                    final JSONObject catalog = new JSONObject();
                    try {
                        JSONObject catRoot = new JSONObject(fetch(MARKET_CATALOG_API));
                        JSONArray catApps = catRoot.optJSONArray("apps");
                        if (catApps != null) {
                            for (int k = 0; k < catApps.length(); k++) {
                                JSONObject c = catApps.getJSONObject(k);
                                String cid = c.optString("id", "").toLowerCase(Locale.US);
                                if (cid.length() > 0) catalog.put(cid, c);
                            }
                        }
                    } catch (Exception ignore) { }

                    body = fetch(MARKET_API);
                    JSONObject rel = new JSONObject(body);
                    String tag = rel.optString("tag_name", "");
                    JSONArray assets = rel.optJSONArray("assets");
                    JSONArray out = new JSONArray();
                    if (assets != null) {
                        for (int i = 0; i < assets.length(); i++) {
                            JSONObject a = assets.getJSONObject(i);
                            String name = a.optString("name", "");
                            if (!name.toLowerCase(Locale.US).endsWith(".zip")) continue;
                            String dl = a.optString("browser_download_url", "");
                            if (!dl.startsWith("https://github.com/")) continue;
                            JSONObject item = new JSONObject();
                            item.put("name", name);
                            item.put("size", a.optLong("size", 0));
                            item.put("url", GH_PROXY + dl);
                            // 从文件名猜 id/版本：mahjong-v1.2.0.zip → mahjong / 1.2.0
                            String stem = name.substring(0, name.length() - 4);
                            int dash = stem.lastIndexOf("-v");
                            String appId;
                            if (dash > 0) {
                                appId = stem.substring(0, dash).toLowerCase(Locale.US);
                                item.put("version", stem.substring(dash + 2));
                            } else {
                                appId = stem.toLowerCase(Locale.US);
                            }
                            item.put("id", appId);
                            // 合并 catalog 元数据：显示名/描述/分类/图标/精确版本号。
                            // catalog 里版本更可靠（versionCode 用于覆盖升级判断），故覆盖文件名猜测值。
                            JSONObject meta = catalog.optJSONObject(appId);
                            if (meta != null) {
                                String[] keys = {"name", "desc", "category", "icon", "version", "versionCode"};
                                for (String k : keys) {
                                    if (meta.has(k)) item.put(k, meta.opt(k));
                                }
                            }
                            out.put(item);
                        }
                    }
                    JSONObject res = new JSONObject();
                    res.put("ok", true);
                    res.put("tag", tag);
                    res.put("apps", out);
                    js("window.BoxUI&&BoxUI.onMarket(" + res.toString() + ")");
                } catch (Exception e) {
                    String mm = e.getMessage();
                    JSONObject res = new JSONObject();
                    try {
                        res.put("ok", false);
                        res.put("msg", "市场暂时不可用: " + (mm == null ? "网络错误" : mm));
                    } catch (Exception ignored) {
                    }
                    js("window.BoxUI&&BoxUI.onMarket(" + res.toString() + ")");
                }
            }
        }).start();
    }

    // ---------- 宿主自升级 ----------

    private volatile String selfUpdateUrl = null;
    private volatile long selfUpdateSize = 0;
    private volatile String selfUpdateVer = null;
    private boolean installAfterPermission = false;

    /** 本地版本（versionName），失败时回退字符串。 */
    private String localVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /** 点分版本号比较：a>b 返回正数，相等 0，a<b 返回负数。非法段当 0。 */
    static int compareVersion(String a, String b) {
        String[] x = (a == null ? "" : a).split("\\.");
        String[] y = (b == null ? "" : b).split("\\.");
        int n = Math.max(x.length, y.length);
        for (int i = 0; i < n; i++) {
            int xi = 0, yi = 0;
            try { xi = Integer.parseInt(x[i].trim()); } catch (Exception ignored) { }
            try { yi = Integer.parseInt(y[i].trim()); } catch (Exception ignored) { }
            if (xi != yi) return xi - yi;
        }
        return 0;
    }

    /** 拉取 openmini latest Release，解析 APK 资产版本，与本地版本比较。
     *  回调 window.BoxUI.onSelfUpdate(json)。 */
    private void checkSelfUpdate() {
        new Thread(new Runnable() {
            public void run() {
                JSONObject res = new JSONObject();
                try {
                    JSONObject rel = new JSONObject(fetch(SELF_UPDATE_API));
                    String tag = rel.optString("tag_name", "");
                    String notes = rel.optString("name", "");
                    JSONArray assets = rel.optJSONArray("assets");
                    String bestVer = null, bestUrl = null;
                    long bestSize = 0;
                    if (assets != null) {
                        for (int i = 0; i < assets.length(); i++) {
                            JSONObject a = assets.getJSONObject(i);
                            String name = a.optString("name", "");
                            Matcher m = APK_VER.matcher(name);
                            if (!m.find()) continue;
                            String v = m.group(1);
                            if (bestVer == null || compareVersion(v, bestVer) > 0) {
                                bestVer = v;
                                String dl = a.optString("browser_download_url", "");
                                if (!dl.startsWith("https://github.com/")) continue;
                                bestUrl = GH_PROXY + dl;
                                bestSize = a.optLong("size", 0);
                            }
                        }
                    }
                    if (bestVer == null || bestUrl == null) throw new IOException("没有找到安装包");
                    String local = localVersion();
                    boolean has = compareVersion(bestVer, local) > 0;
                    selfUpdateUrl = bestUrl;
                    selfUpdateVer = bestVer;
                    selfUpdateSize = bestSize;
                    res.put("ok", true);
                    res.put("hasUpdate", has);
                    res.put("version", bestVer);
                    res.put("local", local);
                    res.put("tag", tag);
                    res.put("notes", notes);
                    res.put("size", bestSize);
                } catch (Exception e) {
                    String mm = e.getMessage();
                    try {
                        res.put("ok", false);
                        res.put("msg", "检查失败: " + (mm == null ? e.getClass().getSimpleName() : mm));
                    } catch (Exception ignored) { }
                }
                js("window.BoxUI&&BoxUI.onSelfUpdate(" + res.toString() + ")");
            }
        }).start();
    }

    /** 用户点击升级：先申请「安装未知应用」权限，再下载安装。 */
    private void installSelfUpdate() {
        if (selfUpdateUrl == null) {
            js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":false,\"msg\":\"请先检查更新\"})");
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            installAfterPermission = true;
            try {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName()));
                startActivityForResult(i, REQ_INSTALL_UNKNOWN);
                toast("请允许小盒子安装应用，然后会自动继续");
            } catch (Exception e) {
                installAfterPermission = false;
                js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":false,\"msg\":\"无法打开安装权限设置\"})");
            }
            return;
        }
        doDownloadAndInstall();
    }

    private void doDownloadAndInstall() {
        final String url = selfUpdateUrl;
        if (url == null) return;
        new Thread(new Runnable() {
            public void run() {
                File apk = new File(getCacheDir(), UPDATE_APK);
                try {
                    if (apk.exists()) apk.delete();
                    downloadSelf(url, apk);
                    if (!apk.isFile() || apk.length() < 10240) throw new IOException("安装包不完整");
                    runOnUiThread(new Runnable() {
                        public void run() {
                            try {
                                Uri uri = Uri.parse("content://com.openmini.host.apkprovider/" + UPDATE_APK);
                                Intent i = new Intent(Intent.ACTION_INSTALL_PACKAGE);
                                i.setDataAndType(uri, "application/vnd.android.package-archive");
                                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                i.putExtra(Intent.EXTRA_NOT_UNKNOWN_SOURCE, true);
                                js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":true,\"msg\":\"正在安装…\"})");
                                startActivity(i);
                            } catch (Exception e) {
                                js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":false,\"msg\":\"无法调起安装器\"})");
                            }
                        }
                    });
                } catch (Exception e) {
                    String mm = e.getMessage();
                    js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":false,\"msg\":\"下载失败: "
                            + (mm == null ? e.getClass().getSimpleName() : mm) + "\"})");
                }
            }
        }).start();
    }

    /** 下载更新包，进度回调 onSelfUpdateProgress。 */
    private void downloadSelf(String urlStr, File out) throws IOException {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            String proto = u.getProtocol();
            if (!"http".equals(proto) && !"https".equals(proto)) throw new IOException("只支持 http/https");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "OpenMini-Updater/1.0");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            int total = c.getContentLength();
            InputStream in = c.getInputStream();
            OutputStream fo = new FileOutputStream(out);
            try {
                byte[] buf = new byte[16384];
                int n;
                long sum = 0;
                int last = -1;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    sum += n;
                    if (sum > 40L * 1024 * 1024) throw new IOException("安装包超过 40MB");
                    if (total > 0) {
                        int pct = (int) (sum * 100 / total);
                        if (pct != last) {
                            last = pct;
                            js("window.BoxUI&&BoxUI.onSelfUpdateProgress(" + pct + ")");
                        }
                    }
                }
            } finally {
                AppStore.closeQuietly(fo);
                AppStore.closeQuietly(in);
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 轻量 GET，返回字符串；供 API 调用，限制体积防滥用。 */
    private static String fetch(String urlStr) throws IOException {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(12000);
            c.setReadTimeout(20000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "OpenMini/1.2");
            c.setRequestProperty("Accept", "application/vnd.github+json");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            InputStream in = c.getInputStream();
            java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
            try {
                byte[] buf = new byte[8192];
                int n;
                long sum = 0;
                while ((n = in.read(buf)) > 0) {
                    sum += n;
                    if (sum > 2L * 1024 * 1024) throw new IOException("响应过大");
                    bo.write(buf, 0, n);
                }
                return new String(bo.toByteArray(), "UTF-8");
            } finally {
                AppStore.closeQuietly(in);
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------- 装包通道 ----------

    private void installFromUrl(final String urlStr) {
        if (!inLauncher()) return;
        if (urlStr == null || urlStr.trim().length() == 0) {
            AppStore.Result r = new AppStore.Result();
            r.ok = false;
            r.msg = "地址为空";
            result(r);
            return;
        }
        new Thread(new Runnable() {
            public void run() {
                File tmp = new File(getCacheDir(), "dl.zip");
                try {
                    download(urlStr.trim(), tmp);
                    FileInputStream fi = new FileInputStream(tmp);
                    try {
                        result(store.install(fi, "url:" + safeHost(urlStr)));
                    } finally {
                        AppStore.closeQuietly(fi);
                    }
                } catch (Exception e) {
                    AppStore.Result r = new AppStore.Result();
                    r.ok = false;
                    String mm = e.getMessage();
                    r.msg = "下载失败: " + (mm == null ? e.getClass().getSimpleName() : mm);
                    result(r);
                } finally {
                    tmp.delete();
                }
            }
        }).start();
    }

    private static String safeHost(String u) {
        try {
            String h = new URL(u).getHost();
            return h == null ? "url" : h;
        } catch (Exception e) {
            return "url";
        }
    }

    private void removeApp(final String id) {
        if (!inLauncher()) return;
        if (id == null || !id.matches(ID_RE) || HOST.equals(id)) {
            AppStore.Result r = new AppStore.Result();
            r.ok = false;
            r.msg = "应用不存在";
            result(r);
            return;
        }
        new Thread(new Runnable() {
            public void run() {
                boolean ok = store.remove(id);
                AppStore.Result r = new AppStore.Result();
                r.ok = ok;
                r.msg = ok ? "已删除" : "删除失败";
                result(r);
            }
        }).start();
    }

    private void download(String urlStr, File out) throws IOException {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            String proto = u.getProtocol();
            if (!"http".equals(proto) && !"https".equals(proto)) throw new IOException("只支持 http/https");
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "OpenMini/1.1");
            int code = c.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            int total = c.getContentLength();
            InputStream in = c.getInputStream();
            OutputStream fo = new FileOutputStream(out);
            try {
                byte[] buf = new byte[16384];
                int n;
                long sum = 0;
                int last = -1;
                while ((n = in.read(buf)) > 0) {
                    fo.write(buf, 0, n);
                    sum += n;
                    if (sum > 40L * 1024 * 1024) throw new IOException("文件超过 40MB");
                    if (total > 0) {
                        int pct = (int) (sum * 100 / total);
                        if (pct != last) {
                            last = pct;
                            progress(pct);
                        }
                    }
                }
            } finally {
                AppStore.closeQuietly(fo);
                AppStore.closeQuietly(in);
            }
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void installFromUri(final Uri uri) {
        new Thread(new Runnable() {
            public void run() {
                try {
                    InputStream in = getContentResolver().openInputStream(uri);
                    if (in == null) throw new IOException("读不到这个文件");
                    try {
                        result(store.install(in, "picker"));
                    } finally {
                        AppStore.closeQuietly(in);
                    }
                } catch (Exception e) {
                    AppStore.Result r = new AppStore.Result();
                    r.ok = false;
                    String mm = e.getMessage();
                    r.msg = "安装失败: " + (mm == null ? e.getClass().getSimpleName() : mm);
                    result(r);
                }
            }
        }).start();
    }

    /**
     * 外部应用可以通过 VIEW intent 把 zip 丢给我们。这种「别人递过来的包」必须先
     * 让用户确认，避免其他 App 一点就把东西塞进盒子里。
     */
    private void handleViewIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return;
        final Uri uri = intent.getData();
        if (uri == null) return;
        if (!inLauncher()) goHome();
        new AlertDialog.Builder(this)
                .setTitle("安装应用包")
                .setMessage("有应用想向小盒子安装一个包：\n\n" + uri + "\n\n只从你信任的来源安装。")
                .setNegativeButton("取消", null)
                .setPositiveButton("安装", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        installFromUri(uri);
                    }
                })
                .show();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK && res == RESULT_OK && data != null && data.getData() != null) {
            installFromUri(data.getData());
        }
        if (req == REQ_INSTALL_UNKNOWN) {
            boolean granted = Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls();
            if (granted && installAfterPermission) {
                installAfterPermission = false;
                doDownloadAndInstall();
            } else if (!granted) {
                installAfterPermission = false;
                js("window.BoxUI&&BoxUI.onSelfInstall({\"ok\":false,\"msg\":\"未获得安装权限\"})");
            }
        }
    }

    // ---------- 生命周期 ----------

    @Override
    public void onBackPressed() {
        if (!inLauncher()) {
            goHome();
            return;
        }
        if (overlayOpen) {
            js("window.BoxUI&&BoxUI.closeOverlays&&BoxUI.closeOverlays()");
            overlayOpen = false;
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackAt < 2000) {
            super.onBackPressed();
        } else {
            lastBackAt = now;
            toast("再按一次退出");
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
        // 局域网通道不随生命周期关闭：屏灭了也可能在上传，靠 PIN + 内网限制 + 空闲超时兜底
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
