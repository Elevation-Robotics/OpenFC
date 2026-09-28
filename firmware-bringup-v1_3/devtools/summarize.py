#!/usr/bin/env python3
# Copyright 2026 Mack Kemper
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""First pass over a capture or relay recording.

  py summarize.py cap.jsonl

Groups records by port, direction, leading byte and length, and prints how
many there are, how many are distinct, the median gap between them, which
byte positions vary, and a few examples. No board needed.
"""
import argparse
from collections import defaultdict

from _common import load_records


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--examples", type=int, default=3)
    a = ap.parse_args()

    groups = defaultdict(list)
    for ev in load_records(a.file):
        b = bytes.fromhex(ev["h"])
        groups[(ev["p"], ev["d"], b[0] if b else 0, len(b))].append((ev["t"], b))
    for (port, d, first, ln), recs in sorted(groups.items()):
        frames = [b for _, b in recs]
        distinct = list(dict.fromkeys(frames))
        varying = [i for i in range(ln) if len({b[i] for b in frames}) > 1]
        ts = sorted(t for t, _ in recs)
        gaps = sorted(y - x for x, y in zip(ts, ts[1:]) if 0 < y - x < 5_000_000)
        gap = f", median gap {gaps[len(gaps) // 2] / 1000:.1f} ms" if gaps else ""
        print(f"{port} {d} {first:02X} len={ln}: {len(frames)} records, {len(distinct)} distinct{gap}")
        if varying:
            print(f"    varying bytes: {varying}")
        for ex in distinct[:a.examples]:
            print("    " + " ".join(f"{x:02X}" for x in ex))


if __name__ == "__main__":
    main()
