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
"""Publish the V1_3 firmware pair to the web flasher.

The V1_3 board carries two MCUs and the site flashes them in two steps
(app/flash/v1_3): the ESP32-S3 with esptool-js from a merged image at 0x0,
then the RP2350 through the ESP32's SWD bridge from a raw flash image. Run
after `pio run` in both ../esp32 and ../rp2350:

    py tools/publish_firmware.py

Writes public/firmware/openfc-v13-esp32-<ver>-merged.bin and
public/firmware/openfc-v13-rp2350-<ver>.bin and prints the `v13_releases`
entry to paste into public/firmware/manifest.json.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ESP32_DIR = ROOT / "esp32"
ESP32_BUILD = ESP32_DIR / ".pio" / "build" / "esp32-s3-devkitc-1"
RP2350_BIN = ROOT / "rp2350" / ".pio" / "build" / "rpipico2" / "firmware.bin"
OUT_DIR = ROOT.parent / "public" / "firmware"
ESPTOOL = Path(os.path.expanduser("~")) / ".platformio" / "packages" / "tool-esptoolpy" / "esptool.py"

# default_8MB.csv layout - same offsets as the production 16MB layout; only
# the --flash_size header differs (see ../esp32/platformio.ini for why 8MB).
PARTS = [
    ("0x0", ESP32_BUILD / "bootloader.bin"),
    ("0x8000", ESP32_BUILD / "partitions.bin"),
    ("0x10000", ESP32_BUILD / "firmware.bin"),
]


def fw_version() -> str:
    ini = (ESP32_DIR / "platformio.ini").read_text(encoding="utf-8")
    m = re.search(r'-DOPENFC_FW_VERSION=\\"([^\\"]+)\\"', ini)
    if not m:
        sys.exit("OPENFC_FW_VERSION not found in esp32/platformio.ini")
    return m.group(1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    for _, p in PARTS:
        if not p.exists():
            sys.exit(f"missing {p} - run `pio run` in esp32/ first")
    if not RP2350_BIN.exists():
        sys.exit(f"missing {RP2350_BIN} - run `pio run` in rp2350/ first")
    if not ESPTOOL.exists():
        sys.exit(f"missing {ESPTOOL} - run `pio run` to install the toolchain")

    version = fw_version()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    esp_out = OUT_DIR / f"openfc-v13-esp32-{version}-merged.bin"
    rp_out = OUT_DIR / f"openfc-v13-rp2350-{version}.bin"

    args = [sys.executable, str(ESPTOOL), "--chip", "esp32s3", "merge_bin",
            "--flash_mode", "dio", "--flash_size", "8MB", "-o", str(esp_out)]
    for offset, p in PARTS:
        args += [offset, str(p)]
    subprocess.run(args, check=True)
    shutil.copyfile(RP2350_BIN, rp_out)

    entry = {
        "version": version,
        "released": "YYYY-MM-DD",
        "description": "",
        "changelog": "",
        "esp32": {
            "download_url": f"/firmware/{esp_out.name}",
            "sha256": sha256(esp_out),
            "size": esp_out.stat().st_size,
        },
        "rp2350": {
            "download_url": f"/firmware/{rp_out.name}",
            "sha256": sha256(rp_out),
            "size": rp_out.stat().st_size,
        },
    }
    print(f"\nwrote {esp_out.relative_to(OUT_DIR.parent.parent)} ({entry['esp32']['size']} bytes)")
    print(f"wrote {rp_out.relative_to(OUT_DIR.parent.parent)} ({entry['rp2350']['size']} bytes)")
    print("\nmanifest.json v13_releases entry:")
    print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main()
