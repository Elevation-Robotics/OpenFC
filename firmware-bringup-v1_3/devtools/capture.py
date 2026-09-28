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
"""Record every Smart-port byte while holding a field state, then dump it.

  py capture.py --ports B --state driver --secs 20 --out cap.jsonl

Engages, records the listed ports, holds `state` for `secs` (pinging so the
watchdog stays fed), then leaves the board engaged and Disabled and dumps
the recording as JSON lines. Needs a bench build (OPENFC_DEVTOOLS=1).
"""
import argparse
import json
import time

from _common import events, open_port, port_arg, require_devtools, send, dump_capture


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    port_arg(ap)
    ap.add_argument("--ports", default="A,B,C,D")
    ap.add_argument("--state", default="driver", choices=["disabled", "driver", "auton"])
    ap.add_argument("--secs", type=float, default=20)
    ap.add_argument("--out", default="capture.jsonl")
    ap.add_argument("--stream", action="store_true", help="also send A/B live while recording")
    a = ap.parse_args()
    ports = [p.strip().upper() for p in a.ports.split(",") if p.strip()]

    s = open_port(a.port)
    require_devtools(s)
    n = 0
    with open(a.out, "w") as f:
        send(s, {"cmd": "field_engage", "on": True})
        send(s, {"cmd": "capture", "on": True, "ports": ports, "stream": a.stream})
        end = time.time() + a.secs
        try:
            while time.time() < end:
                send(s, {"cmd": "field_state", "state": a.state})
                for ev in events(s, 1.0, quiet=True):
                    if ev.get("evt") == "bu_cap":
                        f.write(json.dumps(ev) + "\n")
                        n += 1
                    elif ev.get("evt") == "bu_field":
                        print(f"  t={a.secs - (end - time.time()):5.1f}s "
                              + " ".join(f"{p['port']}:fm={p.get('fm')}" for p in ev.get("ports", [])))
        finally:
            send(s, {"cmd": "field_state", "state": "disabled"})
            send(s, {"cmd": "field_engage", "on": False})   # C/D only dump while disengaged
            list(events(s, 0.5, quiet=True))
        m, status = dump_capture(s, f)
        n += m
        send(s, {"cmd": "field_engage", "on": True})
    s.close()
    print(f"wrote {n} records to {a.out}")
    if status:
        print("status:", json.dumps({k: status[k] for k in ("ab", "cd") if k in status}))


if __name__ == "__main__":
    main()
