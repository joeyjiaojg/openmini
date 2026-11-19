"""自动推进麻将对局：检测操作按钮（胡/杠/碰）自动点击，否则打出手牌最后一张"""
import subprocess
import time
import sys

from PIL import Image

ADB = r"C:/Users/joeyj/WorkBuddy/2026-11-18-22-35-39/.workbuddy/android-sdk/platform-tools/adb.exe"
SER = ["-s", "emulator-5554"]
SHOT = r"C:/Users/joeyj/WorkBuddy/2026-11-18-22-35-39/box/cur.png"

# 按钮配色（rgb）
BTN_COLOR = {
    "hu": (222, 61, 43),
    "gang": (206, 160, 60),
    "peng": (61, 143, 209),
}
DISCARD = (60, 2250)  # 手牌最左一张（缺门牌排序在最前，正好符合"缺门先打"）


def shot():
    with open(SHOT, "wb") as f:
        subprocess.run([ADB] + SER + ["exec-out", "screencap", "-p"], stdout=f, check=True)
    return Image.open(SHOT).convert("RGB")


def tap(x, y):
    subprocess.run([ADB] + SER + ["shell", "input", "tap", str(x), str(y)], check=False)


def find_button(im, target):
    # 返回匹配色块的中心（按钮渐变色从上到下变化，取所有命中点的均值）
    pts = []
    for x in range(150, 950, 6):
        for y in (1620, 1655, 1690, 1720):
            try:
                px = im.getpixel((x, y))
            except Exception:
                continue
            if all(abs(px[i] - target[i]) <= 45 for i in range(3)):
                pts.append((x, y))
    if not pts:
        return None
    return (sum(p[0] for p in pts) // len(pts), sum(p[1] for p in pts) // len(pts))


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 180
    start = time.time()
    n = 0
    while time.time() - start < seconds:
        im = shot()
        pressed = None
        for name in ("hu", "gang", "peng"):
            pos = find_button(im, BTN_COLOR[name])
            if pos:
                print("[%.0fs] press %s at %s" % (time.time() - start, name, pos))
                tap(*pos)
                pressed = name
                time.sleep(1.4)
                break
        if pressed:
            continue
        tap(*DISCARD)
        n += 1
        print("[%.0fs] discard #%d" % (time.time() - start, n))
        time.sleep(2.4)
    im = shot()
    print("final shot saved")


if __name__ == "__main__":
    main()
