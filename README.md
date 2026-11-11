# OpenFC

An open-source field controller for VEX V5. One small USB board drives the competition ports, so a team can run real autonomous and driver periods at practice. The board is flashed and driven from the browser at [openfc.dev](https://openfc.dev), with nothing to install.

Hardware, firmware, protocol and website are all open source. Build boards, sell them, modify them, and drive them from your own code.

## Board revisions

| Board | MCUs | Ports | Firmware | Status |
|---|---|---|---|---|
| **V1.1** | ESP32-S3 | 4 competition ports | [`firmware/`](firmware/) | Working for competition |
| **V1.3** | ESP32-S3 + RP2350 | 4 competition ports + 4 Smart ports | [`firmware-bringup-v1_3/`](firmware-bringup-v1_3/) | Working for competition |

Both boards are in competition use. The firmware version number is unrelated to the board revision. The two boards run different firmware and speak different serial protocols, so each has its own flasher and docs page. The V1.3 firmware keeps the `bring-up` name and `bu_*` protocol from its development.

## Flashing a board

Open [openfc.dev/flash](https://openfc.dev/flash) in Chrome or Edge (Web Serial is required), pick your board revision and connect over USB. The flasher installs the latest competition-certified release for that board: currently 1.4.0 for V1.1 and 0.1.6 for V1.3.

- **V1.1:** one step, about 30 seconds.
- **V1.3:** two steps. Flash the ESP32-S3, **unplug the board and plug it back in**, then flash the RP2350. The flasher will not start the second step until it has seen the power cycle.

## Documentation

The site's docs are the reference. Their source is in `app/docs/`.

- [Integration guide](https://openfc.dev/docs): drive the board from Python, Node or the browser
- [Serial protocol](https://openfc.dev/docs/protocol): every command and event (V1.1)
- [Firmware API](https://openfc.dev/docs/api): certified releases and hashes for both boards, to verify a board or firmware file is an official build
- [Hardware](https://openfc.dev/docs/hardware): design files for both boards, V1.1 pin map
- [V1.3 board](https://openfc.dev/docs/v1_3): pins, Smart-port protocol, two-step flashing
- [License](https://openfc.dev/docs/license)

## Repository layout

| Path | What it is |
|---|---|
| `app/`, `components/`, `lib/` | The website (Next.js static export): flasher, practice match, docs |
| `tests/` | Vitest unit tests for `lib/` |
| `scripts/generate-api.mjs` | Builds `/api/v1` from the firmware manifest and checks every published binary's hash |
| `public/firmware/` | Published firmware images and `manifest.json` |
| `public/hardware/` | Design files: `openfc-v1-*` (V1.1), `openfc-v1_3-*` (V1.3) |
| `firmware/` | V1.1 firmware (PlatformIO) |
| `firmware-bringup-v1_3/` | V1.3 firmware for the ESP32-S3 and RP2350 (PlatformIO), CLI and dev tools; see its README |
| `deploy/`, `Dockerfile`, `docker-compose.yml` | nginx image that serves the static site |

## Running the website

Node 20 or later.

```
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm test
npm run build        # static export in out/
```

`docker compose up` builds and serves the same export through nginx.

## Building firmware

Both firmware trees use [PlatformIO](https://platformio.org/). Run these from the directory shown.

```
firmware/                pio run                            # V1.1 build
firmware/                python scripts/merge_firmware.py   # merged image + hashes for the manifest
firmware-bringup-v1_3/   py tools/publish_firmware.py       # V1.3 release builds of both MCUs + manifest entry
```

To publish a release, add the image to `public/firmware/` and its entry to `public/firmware/manifest.json`: `official_releases` for V1.1, `v13_releases` for V1.3. `npm run build` fails if a hash does not match.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

- Software (website, firmware, tools, docs): [Apache-2.0](LICENSE)
- Hardware designs (V1.1 and V1.3): [CERN-OHL-P-2.0](LICENSE-hardware)
- Exception: the V1.3 SWD flashing code contains code from OpenOCD and is [GPL-3.0-or-later](LICENSE-GPL-3.0). Because it is linked into the V1.3 ESP32-S3 firmware image, that whole image is GPL-3.0-or-later too.

Third-party components and their licences are listed in [NOTICE](NOTICE).

OpenFC is a project of [Elevation Robotics](https://elevationrobotics.org).

## Trademarks

VEX, VEX Robotics and V5 are trademarks of Innovation First, Inc. (IFI). OpenFC is an independent project of Elevation Robotics and is not affiliated with, manufactured, endorsed, approved or sponsored by Innovation First, Inc., VEX Robotics or the Robotics Education & Competition Foundation (RECF). These names are used only to describe hardware compatibility.

## Safety

OpenFC enables and disables real robots. Keep hands clear whenever the field is enabled. Confirm the board behaves as expected in your setup before relying on it. The software and hardware are provided as is, without warranty.
