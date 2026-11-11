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
"""Find which jack is which port.

  py port_map.py --secs 60

Leave a V5 controller in one jack for the first 10 s, then move it to the
next jack every ~10 s, always in the same direction. The tool prints the
order in which ports linked; that order, against the direction you moved,
is the jack map. (REV A, bottom to top: B, A, D, C.) Works on any build.
"""
import argparse
import time

from _common import events, open_port, port_arg, send


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    port_arg(ap)
    ap.add_argument("--secs", type=float, default=60)
    a = ap.parse_args()

    s = open_port(a.port)
    send(s, {"cmd": "field_engage", "on": True})
    t0 = time.time()
    order, prev = [], set()
    print("move the controller between jacks now ...", flush=True)
    while time.time() - t0 < a.secs:
        send(s, {"cmd": "ping"})
        for ev in events(s, 1, quiet=True):
            if ev.get("evt") != "bu_field":
                continue
            linked = {p["port"] for p in ev.get("ports", []) if p["link"]}
            for p in sorted(linked - prev):
                order.append(p)
                print(f"{time.time() - t0:5.1f}s linked on {p}", flush=True)
            prev = linked
    s.close()
    print("order seen:", " -> ".join(order) if order else "none")


if __name__ == "__main__":
    main()
