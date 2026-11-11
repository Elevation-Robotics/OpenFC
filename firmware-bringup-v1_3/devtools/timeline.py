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
"""Time-ordered view of a capture or relay recording.

  py timeline.py relay.jsonl --handshake        # the exchange from the first answered announce
  py timeline.py relay.jsonl --states           # state frames against the controller's echo
  py timeline.py cap.jsonl --port B --states

Who sent a frame: in a relay recording, bytes arriving on a port came from
the device plugged into it, so name the ports with --field and --ctrl. In a
capture, rx is the controller and tx is the board. No board needed.
"""
import argparse

from _common import load_records

MODES = {0x40: "pre-link", 0xC9: "disabled", 0xE1: "driver", 0xD1: "auton"}


def frames(recs):
    """Split each record into 16/32-byte frames by leading byte and CRC-free length guess."""
    for r in recs:
        b = bytes.fromhex(r["h"])
        i = 0
        while i < len(b):
            n = 16 if b[i] in (0x0A, 0x13, 0x03) or (b[i] == 0x02 and i + 1 < len(b) and b[i + 1] == 0x13) else 32
            n = min(n, len(b) - i)
            yield r, b[i:i + n]
            i += n


def who(r, a):
    if a.relay:
        return {a.field: "FIELD", a.ctrl: "CTRL "}.get(r["p"], r["p"])
    return "BOARD" if r["d"] == "tx" else "CTRL "


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--port", help="only this port (captures)")
    ap.add_argument("--relay", action="store_true", help="treat as a relay recording")
    ap.add_argument("--field", default="A", help="relay port the field controller was on (default A)")
    ap.add_argument("--ctrl", default="B", help="relay port the V5 controller was on (default B)")
    ap.add_argument("--handshake", action="store_true", help="print the exchange from the first reply")
    ap.add_argument("--states", action="store_true", help="state frames and the controller's echo")
    ap.add_argument("--count", type=int, default=40, help="frames to print with --handshake")
    a = ap.parse_args()

    recs = load_records(a.file)
    if a.port:
        recs = [r for r in recs if r["p"] == a.port.upper()]
    if not recs:
        raise SystemExit("no records")
    t0 = recs[0]["t"]
    t = lambda r: (r["t"] - t0) / 1e6

    if a.handshake:
        fr = list(frames(recs))
        start = next((i for i, (r, b) in enumerate(fr) if b[:1] == b"\x03"), 0)
        prev = None
        for r, b in fr[max(0, start - 2): start + a.count]:
            gap = "" if prev is None else f"+{r['t'] - prev:8d}us"
            prev = r["t"]
            print(f"{t(r):9.4f}s {gap:>12} {who(r, a)} {len(b):3d} {b.hex(' ').upper()}")

    if a.states:
        last53, lastecho = None, None
        for r, b in frames(recs):
            if b[:1] == b"\x53" and len(b) >= 8 and b[1] != last53:
                last53 = b[1]
                ms = b[4] | (b[5] << 8) | (b[6] << 16)
                print(f"{t(r):7.2f}s {who(r, a)} 53 {MODES.get(b[1], hex(b[1]))} remaining={ms} ms")
            if b[:1] == b"\xA7" and len(b) >= 24:
                key = (b[3], b[6], b[17])
                if key != lastecho:
                    lastecho = key
                    print(f"{t(r):7.2f}s {who(r, a)} A7 enable={b[3]:02X} mode={MODES.get(b[6], hex(b[6]))} "
                          f"secs={b[7]} b16={b[16]:02X} b17={b[17]:02X} name={b[18:24].decode(errors='replace')!r}")


if __name__ == "__main__":
    main()
