package com.openmini.host;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
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
    private static final String PROMPT_PREFIX = "__om__";
    private static final int REQ_PICK = 1001;

    private static final String CSP_LAUNCHER =
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            + "img-src 'self' https: data:; connect-src 'self'; frame-src 'none'; "
            + "object-src 'none'; base-uri 'none'; form-action 'none'";

    private WebView webView;
    private AppStore store;
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

    /** 按包 manifest 的 orientation 字段转屏：landscape/sensor 可选，默认竖屏 */
    private void applyOrientation(JSONObject manifest) {
        String o = manifest == null ? "" : manifest.optString("orientation", "");
        try {
            if ("landscape".equalsIgnoreCase(o)) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            } else if ("sensor".equalsIgnoreCase(o)) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
            } else {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
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
            }
        } catch (Exception e) {
            return notFound();
        }

        r.setResponseHeaders(headers);
        return r;
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
