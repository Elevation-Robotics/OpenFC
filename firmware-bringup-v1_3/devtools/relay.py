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
"""Record a real field controller through the board.

  py relay.py --secs 60 --out relay.jsonl

Put the VEX field controller on one of the bottom two jacks (B, A) and the
V5 controller on the other, start this, and power-cycle the controller so
the handshake is recorded. The board passes every byte between A and B and
records it; it is silent over USB until the relay ends. Afterwards the
board is left engaged and Disabled. Needs a bench build (OPENFC_DEVTOOLS=1).
"""
import argparse
import json
import sys

from _common import dump_capture, events, open_port, port_arg, require_devtools, send, wait_for


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    port_arg(ap)
    ap.add_argument("--secs", type=float, default=60, help="up to 120")
    ap.add_argument("--hold-us", type=int, default=40, help="driver hold after the last forwarded byte")
    ap.add_argument("--out", default="relay.jsonl")
    a = ap.parse_args()

    s = open_port(a.port)
    require_devtools(s)
    send(s, {"cmd": "field_engage", "on": False})
    list(events(s, 0.3, quiet=True))
    send(s, {"cmd": "relay", "ms": int(a.secs * 1000), "hold_us": a.hold_us})
    print(f"relaying A<->B for {a.secs:.0f} s (the board is silent until it finishes)...")
    ev = wait_for(s, lambda e: e.get("evt") in ("bu_relay_result", "bu_error"), a.secs + 10)
    print("result:", json.dumps(ev))
    if not ev or ev.get("evt") != "bu_relay_result":
        sys.exit("relay failed")
    with open(a.out, "w") as f:
        n, _ = dump_capture(s, f)
    send(s, {"cmd": "field_engage", "on": True})
    s.close()
    print(f"wrote {n} records to {a.out}")


if __name__ == "__main__":
    main()
