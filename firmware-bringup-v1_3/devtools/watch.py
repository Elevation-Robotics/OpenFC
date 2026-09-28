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
"""Watch the board without sending it anything.

  py watch.py --reset --secs 30      # reboot, then check the boot default
  py watch.py --secs 10              # just listen

With --reset the ESP32 is rebooted through the CH340's auto-reset line
first. Prints the hello, every RP2350 reset or error, and each port's link
state whenever it changes (and every 5 s). A healthy board shows each
connected port reach fm=2 within about 2 s and no RP2350 resets. Works on
any build.
"""
import argparse
import json
import time

import serial

from _common import fmt_port


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default="COM3")
    ap.add_argument("--secs", type=float, default=30)
    ap.add_argument("--reset", action="store_true", help="reboot the ESP32 first")
    a = ap.parse_args()

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = a.port, 115200, 0.05
    s.dtr = False
    s.rts = False
    s.open()
    if a.reset:
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    t0 = time.time()
    last, prev = -99.0, None
    while time.time() - t0 < a.secs:
        line = s.readline()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        now = time.time() - t0
        if ev.get("evt") in ("bu_hello", "bu_rp2350_reset", "bu_error", "bu_field_watchdog", "bu_match_end"):
            print(f"{now:5.1f}s {json.dumps(ev)}", flush=True)
        elif ev.get("evt") == "bu_field":
            key = tuple((p["port"], p["link"], p["fm"]) for p in ev.get("ports", []))
            if key != prev or now - last >= 5:
                prev, last = key, now
                print(f"{now:5.1f}s state={ev['state']} rp2350={ev.get('rp2350')}  "
                      + "  ".join(fmt_port(p) for p in ev.get("ports", [])), flush=True)
    s.close()


if __name__ == "__main__":
    main()
