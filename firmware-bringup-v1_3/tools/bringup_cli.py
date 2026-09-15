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
"""Host-side console for the V1_3 bring-up ESP32 firmware (JSON lines over
the CH340 UART), including the ESP32->RP2350 SWD flash path.

  py bringup_cli.py --port COM3 monitor [--secs 5]
  py bringup_cli.py --port COM3 cmd '{"cmd":"rp2350_spi","op":"ping"}'
  py bringup_cli.py --port COM3 flash-rp2350 ..\\rp2350\\.pio\\build\\rpipico2\\firmware.bin
  py bringup_cli.py --port COM3 listen C [--secs 3]
  py bringup_cli.py --port COM3 engage --state driver --secs 30
"""
import argparse, base64, json, sys, time
import serial

CHUNK = 384  # matches the ESP32's rp2350_flash_data decode buffer


def open_port(name):
    # Keep DTR/RTS both de-asserted so the CH340 auto-reset pair (Q1/Q2)
    # does not reboot the ESP32 when the port opens.
    s = serial.Serial()
    s.port, s.baudrate, s.timeout = name, 115200, 0.05
    s.dtr = False
    s.rts = False
    s.open()
    time.sleep(0.3)
    s.reset_input_buffer()
    return s


def send(s, obj):
    s.write((json.dumps(obj) + "\n").encode())


def events(s, secs, quiet=False):
    """Yield parsed JSON events for `secs` seconds; print non-heartbeat lines."""
    end = time.time() + secs
    while time.time() < end:
        line = s.readline()
        if not line:
            continue
        txt = line.decode(errors="replace").strip()
        if not txt:
            continue
        try:
            ev = json.loads(txt)
        except ValueError:
            if not quiet:
                print("  <raw>", txt)
            continue
        if not quiet and ev.get("evt") != "bu_state":
            print(" ", txt)
        yield ev


def wait_for(s, pred, secs):
    for ev in events(s, secs, quiet=True):
        if pred(ev):
            return ev
    return None


def swd_probe(s):
    send(s, {"cmd": "rp2350_swd_probe"})
    return wait_for(s, lambda e: e.get("evt") == "bu_swd_probe", 5)


def cmd_flash(s, path):
    data = open(path, "rb").read()
    print(f"image {path}: {len(data)} bytes")
    # After an ESP32 reflash the RP2350 is held in reset (RUN low) until told
    # otherwise; SWD returns no DPIDR while it sits there. Release it first.
    send(s, {"cmd": "rp2350_ctrl", "run": True})
    wait_for(s, lambda e: e.get("evt") == "bu_rp2350_state", 2)
    time.sleep(0.2)
    ev = swd_probe(s)
    if not ev or not ev.get("ok"):
        time.sleep(0.5)
        ev = swd_probe(s)
    print("probe:", ev)
    if not ev or not ev.get("ok"):
        sys.exit("SWD probe failed")
    send(s, {"cmd": "rp2350_flash_begin", "size": len(data)})
    ev = wait_for(s, lambda e: e.get("evt") == "bu_flash_status" and e.get("stage") == "begin", 30)
    print("begin:", ev)
    if not ev or not ev.get("ok"):
        sys.exit("flash_begin failed")
    t0 = time.time()
    for off in range(0, len(data), CHUNK):
        b64 = base64.b64encode(data[off:off + CHUNK]).decode()
        send(s, {"cmd": "rp2350_flash_data", "b64": b64})
        ev = wait_for(s, lambda e: e.get("evt") == "bu_flash_status" and e.get("stage") == "data", 10)
        if not ev or not ev.get("ok"):
            sys.exit(f"flash_data failed at {off}: {ev}")
        if (off // CHUNK) % 20 == 0:
            print(f"  {ev.get('received')}/{len(data)}")
    send(s, {"cmd": "rp2350_flash_end"})
    ev = wait_for(s, lambda e: e.get("evt") == "bu_flash_status" and e.get("stage") == "end", 30)
    print("end:", ev, f"({time.time() - t0:.1f}s)")
    if not ev or not ev.get("ok"):
        sys.exit("flash_end failed")


def cmd_engage(s, state, secs):
    send(s, {"cmd": "field_engage", "on": True})
    send(s, {"cmd": "field_state", "state": state})
    end = time.time() + secs
    try:
        while time.time() < end:
            send(s, {"cmd": "field_state", "state": state})  # feeds the host watchdog
            for ev in events(s, 1.0, quiet=True):
                if ev.get("evt") == "bu_field":
                    ports = {p["port"]: p for p in ev.get("ports", [])}
                    print(f"  t={secs - (end - time.time()):5.1f}s rp2350={ev.get('rp2350')} "
                          + " ".join(f"{k}:link={v.get('link')},fm={v.get('fm')},pack={v.get('pack')}"
                                     for k, v in ports.items()))
                elif ev.get("evt") not in ("bu_state", "ack"):
                    print(" ", json.dumps(ev))
    finally:
        send(s, {"cmd": "field_engage", "on": False})
        list(events(s, 0.5, quiet=True))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM3")
    sub = ap.add_subparsers(dest="op", required=True)
    sub.add_parser("monitor").add_argument("--secs", type=float, default=5)
    p = sub.add_parser("cmd"); p.add_argument("json"); p.add_argument("--secs", type=float, default=2)
    sub.add_parser("flash-rp2350").add_argument("bin")
    p = sub.add_parser("listen"); p.add_argument("port_name"); p.add_argument("--secs", type=float, default=3)
    p = sub.add_parser("engage"); p.add_argument("--state", default="disabled"); p.add_argument("--secs", type=float, default=30)
    a = ap.parse_args()

    s = open_port(a.port)
    if a.op == "monitor":
        list(events(s, a.secs))
    elif a.op == "cmd":
        send(s, json.loads(a.json))
        list(events(s, a.secs))
    elif a.op == "flash-rp2350":
        cmd_flash(s, a.bin)
    elif a.op == "listen":
        end = time.time() + a.secs
        while time.time() < end:
            send(s, {"cmd": "rp2350_spi", "op": "rs485_raw", "port": a.port_name.upper(), "bytes": []})
            ev = wait_for(s, lambda e: e.get("evt") == "bu_rs485_rx", 1)
            if ev:
                print("  ok=%s seen=%s bytes=%s" % (ev.get("ok"), ev.get("seen"),
                      " ".join("%02X" % b for b in ev.get("bytes", []))))
            time.sleep(0.5)
    elif a.op == "engage":
        cmd_engage(s, a.state, a.secs)
    s.close()


if __name__ == "__main__":
    main()
