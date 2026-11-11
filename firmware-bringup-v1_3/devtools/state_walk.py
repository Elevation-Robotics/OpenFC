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
"""Walk a port through the field states while you watch the controller.

  py state_walk.py --port-letter B
  py state_walk.py --port-letter any --wait 40     # wait for a controller on any port first

Prints a banner at each step so you can match what the controller screen
shows to what was commanded. Default sequence: disabled 5 s, driver 8 s,
auton 8 s, disabled 8 s, driver 5 s, disabled 8 s. Leaves the board engaged
and Disabled. Works on any build.
"""
import argparse
import json
import sys
import time

from _common import PORTS, events, fmt_port, open_port, port_arg, port_status, send

DEFAULT_STEPS = "disabled:5,driver:8,auton:8,disabled:8,driver:5,disabled:8"


def wait_for_port(s, want, secs):
    t0 = time.time()
    print(f"waiting up to {secs:.0f} s for a controller in field mode on {want} ...", flush=True)
    while time.time() - t0 < secs:
        send(s, {"cmd": "ping"})
        for ev in events(s, 1, quiet=True):
            if ev.get("evt") != "bu_field":
                continue
            for p in ev.get("ports", []):
                if p["port"] in want and p["link"] and p["fm"] == 2:
                    return p["port"]
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    port_arg(ap)
    ap.add_argument("--port-letter", default="any", help="Smart port to watch, or 'any'")
    ap.add_argument("--wait", type=float, default=40, help="seconds to wait for field mode first")
    ap.add_argument("--steps", default=DEFAULT_STEPS, help="state:secs,... (default %(default)s)")
    a = ap.parse_args()
    steps = [(st, int(n)) for st, n in (x.split(":") for x in a.steps.split(","))]

    s = open_port(a.port)
    send(s, {"cmd": "field_engage", "on": True})
    want = PORTS if a.port_letter.lower() == "any" else a.port_letter.upper()
    port = wait_for_port(s, want, a.wait)
    if not port:
        sys.exit(f"no controller reached field mode on {want}")
    print(f"=== controller in field mode on port {port} ===", flush=True)

    t0 = time.time()
    for st, secs in steps:
        print(f"########## {st.upper()} ({secs} s) ##########", flush=True)
        shown = False
        for _ in range(secs):
            send(s, {"cmd": "field_state", "state": st})
            for ev in events(s, 1, quiet=True):
                if ev.get("evt") == "bu_field" and not shown:
                    shown = True
                    print(f"{time.time() - t0:5.1f}s board={ev['state']} {fmt_port(port_status(ev, port))}", flush=True)
                elif ev.get("evt") in ("bu_match_end", "bu_field_watchdog", "bu_error", "bu_rp2350_reset"):
                    print(f"{time.time() - t0:5.1f}s {json.dumps(ev)}", flush=True)
    send(s, {"cmd": "field_state", "state": "disabled"})
    s.close()
    print("done; board left engaged and Disabled")


if __name__ == "__main__":
    main()
