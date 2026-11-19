package com.xiaoyou.box;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
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

/**
 * 单 Activity 宿主：内置 WebView 只认 *.apps.local 这一组虚拟域名。
 * 启动器（host.apps.local）负责列表和装包，每个游戏跑在 &lt;id&gt;.apps.local，
 * 因为域名不同 = origin 不同，localStorage 天然隔离，存档互不干扰。
 */
public class MainActivity extends Activity {

    static final String DOMAIN = ".apps.local";
    static final String HOST = "host";
    private static final int REQ_PICK = 1001;

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
        // 页面全部走虚拟域名，不需要放开 file:// 权限
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        webView.setBackgroundColor(0xFF14110E);
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(new Bridge(), "Box");

        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        setContentView(webView);
        goHome();

        handleViewIntent(getIntent());
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
        if (webView != null) webView.loadUrl(url(HOST, "/index.html"));
    }

    private void openApp(String id) {
        JSONObject m = store.get(id);
        if (m == null) {
            toast("应用不存在");
            return;
        }
        currentAppId = id;
        webView.loadUrl(url(id, "/" + store.entryOf(id)));
    }

    private boolean inLauncher() {
        return currentAppId == null;
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
            return intercept(req.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView v, String u) {
            if (u == null) return true;
            if (u.contains(DOMAIN)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
            } catch (Exception ignored) {
            }
            return true;
        }
    }

    private WebResourceResponse intercept(Uri u) {
        String host = u.getHost();
        if (host == null || !host.endsWith(DOMAIN)) return null;
        String sub = host.substring(0, host.length() - DOMAIN.length());
        String path = u.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        if (path.contains("..")) return notFound();

        String rel = path.startsWith("/") ? path.substring(1) : path;
        InputStream in;
        try {
            if (HOST.equals(sub)) {
                in = getAssets().open("host/" + rel);
            } else {
                if (!sub.matches("[a-z0-9][a-z0-9_-]{0,39}")) return notFound();
                File f = new File(store.dir(sub), rel);
                if (!f.isFile()) return notFound();
                in = new FileInputStream(f);
            }
        } catch (Exception e) {
            return notFound();
        }

        String mime = mimeOf(rel);
        HashMap<String, String> headers = new HashMap<String, String>();
        headers.put("Cache-Control", "no-store");
        WebResourceResponse r = new WebResourceResponse(mime, charsetOf(mime), in);
        r.setResponseHeaders(headers);
        return r;
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(),
                new ByteArrayInputStream("404".getBytes()));
    }

    private static String mimeOf(String p) {
        String s = p.toLowerCase();
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

    public class Bridge {

        @JavascriptInterface
        public String apps() {
            return store.listJson();
        }

        @JavascriptInterface
        public String meta() {
            JSONObject o = new JSONObject();
            try {
                o.put("version", getPackageManager().getPackageInfo(getPackageName(), 0).versionName);
                o.put("appId", currentAppId == null ? "" : currentAppId);
                o.put("lanRunning", server.isRunning());
                o.put("serverSocket", server.isRunning() ? "http://" + MiniServer.localIp() + ":" + server.getPort() : "");
            } catch (Exception ignored) {
            }
            return o.toString();
        }

        @JavascriptInterface
        public void installUrl(final String urlStr) {
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
                    android.util.Log.i("box", "installUrl begin: " + urlStr);
                    try {
                        download(urlStr.trim(), tmp);
                        android.util.Log.i("box", "downloaded " + tmp.length() + " bytes");
                        FileInputStream fi = new FileInputStream(tmp);
                        try {
                            result(store.install(fi, "url"));
                        } finally {
                            AppStore.closeQuietly(fi);
                        }
                    } catch (Exception e) {
                        AppStore.Result r = new AppStore.Result();
                        r.ok = false;
                        String m = e.getMessage();
                        r.msg = "下载失败: " + (m == null ? e.getClass().getSimpleName() : m);
                        result(r);
                    } finally {
                        tmp.delete();
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void pick() {
            if (!inLauncher()) return;
            runOnUiThread(new Runnable() {
                public void run() {
                    try {
                        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                        i.addCategory(Intent.CATEGORY_OPENABLE);
                        i.setType("*/*");
                        startActivityForResult(i, REQ_PICK);
                    } catch (Exception e) {
                        toast("没有可用的文件选择器");
                    }
                }
            });
        }

        @JavascriptInterface
        public void remove(final String id) {
            if (!inLauncher() || id == null) return;
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

        @JavascriptInterface
        public void open(final String id) {
            if (id == null) return;
            runOnUiThread(new Runnable() {
                public void run() {
                    openApp(id);
                }
            });
        }

        @JavascriptInterface
        public void home() {
            runOnUiThread(new Runnable() {
                public void run() {
                    goHome();
                }
            });
        }

        @JavascriptInterface
        public String serverStart() {
            JSONObject o = new JSONObject();
            try {
                String u = server.start();
                o.put("ok", true);
                o.put("url", u);
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

        @JavascriptInterface
        public void serverStop() {
            server.stop();
        }

        @JavascriptInterface
        public void setOverlay(boolean open) {
            overlayOpen = open;
        }

        @JavascriptInterface
        public void toastMsg(String m) {
            toast(m);
        }

        @JavascriptInterface
        public void back() {
            runOnUiThread(new Runnable() {
                public void run() {
                    if (!inLauncher()) goHome();
                }
            });
        }
    }

    // ---------- 装包通道 ----------

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
            c.setRequestProperty("User-Agent", "XiaoYouBox/1.0");
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
                    String m = e.getMessage();
                    r.msg = "安装失败: " + (m == null ? e.getClass().getSimpleName() : m);
                    result(r);
                }
            }
        }).start();
    }

    private void handleViewIntent(Intent intent) {
        if (intent == null) return;
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return;
        final Uri uri = intent.getData();
        if (uri != null) installFromUri(uri);
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
            // 输入法自己收起时不会走到这里；这里只处理面板/弹窗
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
