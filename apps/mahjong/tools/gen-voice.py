"""生成麻将语音包：27 个牌名 + 动作词，用 edge-tts 合成 mp3"""
import asyncio
import os
import sys

import edge_tts

VOICE = "zh-CN-XiaoxiaoNeural"
RATE = "+18%"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "voice")

NUMS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
SUITS = ["万", "筒", "条"]


def build_items():
    items = []
    for s in range(3):
        for r in range(1, 10):
            items.append(("p%d" % (s * 9 + r - 1), NUMS[r] + SUITS[s]))
    items += [
        ("a_peng", "碰！"),
        ("a_gang", "杠！"),
        ("a_angang", "暗杠"),
        ("a_bugang", "补杠"),
        ("a_hu", "胡了！"),
        ("a_zimo", "自摸！"),
        ("a_dingque", "缺" + "一门"),
        ("a_liuju", "流局"),
        ("a_ting", "听牌"),
    ]
    return items


async def synth(name, text, out_dir):
    path = os.path.join(out_dir, name + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return os.path.getsize(path)
    c = edge_tts.Communicate(text, VOICE, rate=RATE)
    await c.save(path)
    return os.path.getsize(path)


async def main():
    out_dir = os.path.abspath(OUT)
    os.makedirs(out_dir, exist_ok=True)
    items = build_items()
    total = 0
    for name, text in items:
        size = await synth(name, text, out_dir)
        total += size
        print("%-12s %-6s %6d" % (name, text, size))
    print("files=%d total=%d bytes (%.1f KB)" % (len(items), total, total / 1024.0))


if __name__ == "__main__":
    asyncio.run(main())
