#!/usr/bin/env python3
"""Build the single-file image the web flasher writes at 0x0.

The browser flasher (lib/esptool-flash.ts) does one writeFlash at address 0x0,
so bootloader + partition table + app have to be pre-merged here. Run after
`pio run`:

    python scripts/merge_firmware.py

Emits ../public/firmware/openfc-v<version>-merged.bin and prints the two hashes
the web manifest records:

  binary_sha256 - SHA-256 of the merged file, checked after download.
  app_sha256    - the app image's embedded validation hash, which is what
                  esp_partition_get_sha256() reports at runtime as fw_hash.
"""

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

FIRMWARE_DIR = Path(__file__).resolve().parent.parent
BUILD_DIR = FIRMWARE_DIR / ".pio" / "build" / "esp32-s3-devkitc-1"
OUT_DIR = FIRMWARE_DIR.parent / "public" / "firmware"

# esptool ships inside the PlatformIO toolchain rather than the interpreter that
# runs this script, so use the same copy the build used.
ESPTOOL = (
    Path(os.path.expanduser("~")) / ".platformio" / "packages" / "tool-esptoolpy" / "esptool.py"
)

# Offsets for the default_16MB.csv layout. The app must land at 0x10000 or the
# bootloader will not find it.
PARTS = [
    ("0x0", BUILD_DIR / "bootloader.bin"),
    ("0x8000", BUILD_DIR / "partitions.bin"),
    ("0x10000", BUILD_DIR / "firmware.bin"),
]


def fw_version() -> str:
    ini = (FIRMWARE_DIR / "platformio.ini").read_text(encoding="utf-8")
    m = re.search(r'-DOPENFC_FW_VERSION=\\"([^\\"]+)\\"', ini)
    if not m:
        sys.exit("OPENFC_FW_VERSION not found in platformio.ini")
    return m.group(1)


def app_hash(app_bin: Path) -> str:
    """Read the validation hash esptool appends to the app image."""
    out = subprocess.run(
        [sys.executable, str(ESPTOOL), "--chip", "esp32s3", "image_info", str(app_bin)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    m = re.search(r"Validation Hash:\s*([0-9a-f]{64})", out)
    if not m:
        sys.exit("Validation Hash not found in image_info output")
    return m.group(1)


def main() -> None:
    for _, path in PARTS:
        if not path.exists():
            sys.exit(f"missing {path} - run `pio run` first")
    if not ESPTOOL.exists():
        sys.exit(f"missing {ESPTOOL} - run `pio run` to install the toolchain")

    version = fw_version()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    merged = OUT_DIR / f"openfc-v{version}-merged.bin"

    args = [sys.executable, str(ESPTOOL), "--chip", "esp32s3", "merge_bin",
            # dio must match platformio.ini: a qio image boot-loops these modules.
            "--flash_mode", "dio", "--flash_size", "16MB",
            "-o", str(merged)]
    for offset, path in PARTS:
        args += [offset, str(path)]
    subprocess.run(args, check=True)

    data = merged.read_bytes()
    print(f"\nversion:       {version}")
    print(f"file:          {merged.relative_to(FIRMWARE_DIR.parent)} ({len(data)} bytes)")
    print(f"binary_sha256: {hashlib.sha256(data).hexdigest()}")
    print(f"app_sha256:    {app_hash(PARTS[2][1])}")


if __name__ == "__main__":
    main()
