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
"""Shared helpers for the dev tools: the serial helpers from
../tools/bringup_cli.py, plus the pieces several tools repeat."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))

from bringup_cli import events, open_port, send, wait_for  # noqa: E402,F401

PORTS = "ABCD"


def port_arg(ap, default="COM3"):
    ap.add_argument("--port", default=default, help="serial port of the board (default COM3)")


def require_devtools(s):
    """Exit unless the running firmware was built with the dev tools."""
    send(s, {"cmd": "get_info"})
    hello = wait_for(s, lambda e: e.get("evt") == "bu_hello", 3)
    if not hello:
        sys.exit("no bu_hello: is the board running V1.3 bring-up firmware?")
    if hello.get("devtools") is False:
        sys.exit(f"{hello.get('fw_version')} is a release build (no capture or relay); "
                 "flash a bench build (pio run, default env)")
    return hello


def dump_capture(s, f, timeout=180):
    """Ask for a dump and write every bu_cap record to f. Returns (count, last status)."""
    send(s, {"cmd": "capture", "dump": True})
    n, status = 0, None
    deadline = time.time() + timeout
    while time.time() < deadline:
        for ev in events(s, 1.0, quiet=True):
            if ev.get("evt") == "bu_cap":
                f.write(json.dumps(ev) + "\n")
                n += 1
            elif ev.get("evt") == "bu_cap_status":
                status = ev
                if ev.get("done"):
                    return n, status
    return n, status


def port_status(ev, port):
    return next((p for p in ev.get("ports", []) if p["port"] == port), None)


def fmt_port(p):
    if not p:
        return "-"
    s = f"{p['port']}: link={p['link']} fm={p['fm']} pack={p['pack']}"
    return s + (f" robot={p['robot']}" if p.get("robot") else "")


def load_records(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]
