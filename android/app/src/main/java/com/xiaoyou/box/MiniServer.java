package com.xiaoyou.box;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Collections;
import java.util.Locale;

/**
 * 局域网装包通道：手机开一个小 HTTP 服务，电脑浏览器打开就能拖 zip 进去。
 * 上传接口故意用 PUT + 原始二进制，省掉 multipart 解析（几十行省成几行）。
 */
public class MiniServer {

    public interface Listener {
        void onInstalled(String json);
    }

    private static final long MAX_BODY = 40L * 1024 * 1024;

    private final AppStore store;
    private final int basePort;
    private ServerSocket ss;
    private Thread worker;
    private volatile boolean running;
    private int port;
    private Listener listener;

    public MiniServer(AppStore store, int basePort) {
        this.store = store;
        this.basePort = basePort;
    }

    public void setListener(Listener l) {
        listener = l;
    }

    public boolean isRunning() {
        return running;
    }

    public int getPort() {
        return port;
    }

    public String start() throws IOException {
        if (running) return "http://" + localIp() + ":" + port;
        IOException last = null;
        for (int i = 0; i < 8; i++) {
            int p = basePort + i;
            try {
                ServerSocket s = new ServerSocket();
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress("0.0.0.0", p));
                ss = s;
                port = p;
                break;
            } catch (IOException e) {
                last = e;
            }
        }
        if (ss == null) throw last == null ? new IOException("端口被占用") : last;

        running = true;
        worker = new Thread(new Runnable() {
            public void run() {
                loop();
            }
        }, "box-lan");
        worker.setDaemon(true);
        worker.start();
        return "http://" + localIp() + ":" + port;
    }

    public void stop() {
        running = false;
        if (ss != null) {
            try {
                ss.close();
            } catch (Exception ignored) {
            }
            ss = null;
        }
        worker = null;
    }

    private void loop() {
        while (running) {
            Socket s = null;
            try {
                s = ss.accept();
                handle(s);
            } catch (Exception e) {
                if (!running) break;
            } finally {
                if (s != null) {
                    try {
                        s.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = new BufferedOutputStream(s.getOutputStream());

            StringBuilder head = new StringBuilder();
            int c;
            while ((c = in.read()) != -1) {
                head.append((char) c);
                int L = head.length();
                if (L >= 4 && head.charAt(L - 1) == '\n' && head.charAt(L - 2) == '\r'
                        && head.charAt(L - 3) == '\n' && head.charAt(L - 4) == '\r') break;
                if (L > 16384) break;
            }
            if (head.length() == 0) return;

            String[] lines = head.toString().split("\r\n");
            String[] first = lines[0].split(" ");
            String method = first.length > 0 ? first[0] : "GET";
            String target = first.length > 1 ? first[1] : "/";

            long length = 0;
            for (int i = 1; i < lines.length; i++) {
                String line = lines[i];
                int idx = line.indexOf(':');
                if (idx <= 0) continue;
                String k = line.substring(0, idx).trim().toLowerCase(Locale.US);
                String v = line.substring(idx + 1).trim();
                if ("content-length".equals(k)) {
                    try {
                        length = Long.parseLong(v);
                    } catch (Exception ignored) {
                    }
                }
            }

            if ("PUT".equals(method) && target.startsWith("/upload")) {
                if (length <= 0 || length > MAX_BODY) {
                    respond(out, 400, "text/plain; charset=utf-8", "文件为空或超过 40MB");
                    return;
                }
                File tmp = new File(store.ctx.getCacheDir(), "upload.zip");
                FileOutputStream fo = new FileOutputStream(tmp);
                try {
                    byte[] buf = new byte[16384];
                    long left = length;
                    while (left > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                        if (n <= 0) break;
                        fo.write(buf, 0, n);
                        left -= n;
                    }
                } finally {
                    AppStore.closeQuietly(fo);
                }
                String json;
                try {
                    FileInputStream fi = new FileInputStream(tmp);
                    try {
                        json = store.install(fi, "lan").toJson();
                    } finally {
                        AppStore.closeQuietly(fi);
                    }
                } catch (Exception e) {
                    json = "{\"ok\":false,\"msg\":\"安装失败\"}";
                }
                tmp.delete();
                respond(out, 200, "application/json; charset=utf-8", json);
                if (listener != null) listener.onInstalled(json);
                return;
            }

            if ("OPTIONS".equals(method)) {
                respond(out, 204, "text/plain; charset=utf-8", "");
                return;
            }

            byte[] page = readAsset("host/lan.html");
            if (page == null) page = "<h1>lan.html missing</h1>".getBytes("UTF-8");
            respondBytes(out, 200, "text/html; charset=utf-8", page);
        } catch (Exception ignored) {
            // 单个请求出错不影响服务继续监听
        }
    }

    private byte[] readAsset(String path) {
        try {
            InputStream in = store.ctx.getAssets().open(path);
            try {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                return bo.toByteArray();
            } finally {
                AppStore.closeQuietly(in);
            }
        } catch (Exception e) {
            return null;
        }
    }

    private void respond(OutputStream out, int code, String type, String body) throws IOException {
        respondBytes(out, code, type, body == null ? new byte[0] : body.getBytes("UTF-8"));
    }

    private void respondBytes(OutputStream out, int code, String type, byte[] body) throws IOException {
        String status = code == 200 ? "OK" : code == 204 ? "No Content" : code == 400 ? "Bad Request" : "OK";
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(status).append("\r\n");
        h.append("Content-Type: ").append(type).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Methods: GET, PUT, OPTIONS\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        if (body.length > 0) out.write(body);
        out.flush();
    }

    public static String localIp() {
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                String nm = ni.getName();
                if (nm != null && (nm.startsWith("rmnet") || nm.startsWith("dummy") || nm.startsWith("tun"))) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) {
                        return a.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return "127.0.0.1";
    }
}
