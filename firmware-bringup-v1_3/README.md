# OpenFC V1.3 bring-up firmware

Firmware for the **Open_FC_V1_3 REV A** prototype: an ESP32-S3 that talks to the PC and runs the legacy ports and Smart ports A/B, and an RP2350 that runs Smart ports C/D. It speaks the `bu_*` bring-up protocol, not the certified match protocol, and is kept apart from [`../firmware/`](../firmware/) so neither build can pick up the other.

The user-facing reference (ports, commands, the Smart-port protocol, flashing, troubleshooting) is the site's V1.3 docs page, [`app/docs/v1_3/page.tsx`](../app/docs/v1_3/page.tsx), served at `/docs/v1_3`. This README covers working on the firmware.

## Layout

| Path | What it is |
|---|---|
| `esp32/src/main.cpp` | Host protocol (JSON lines over the CH340), legacy ports, status LEDs, SPI master, RP2350 supervision |
| `esp32/src/devtools.cpp`, `include/devtools.h` | Bench-only: A/B bus capture and the A↔B relay (`OPENFC_DEVTOOLS`) |
| `esp32/src/smart_link.cpp`, `include/smart_link.h` | Smart-port engine, one instance per port (A, B) |
| `esp32/src/swd_rp2350.cpp` | Bit-banged SWD and the RP2350 flash-programming sequence |
| `esp32/include/openfc_pins_v13.h` | ESP32 pin map, jack order |
| `rp2350/src/main.cpp` | SPI slave, C/D engines, and (bench builds) the C/D capture ring |
| `rp2350/src/smart_link_rp.cpp`, `include/smart_link_rp.h` | The same engine, arduino-pico glue |
| `*/include/openfc_frames.h` | Smart-port frames, CRC, and the recorded field-controller replies |
| `*/include/openfc_spi_link.h` | ESP32↔RP2350 SPI framing and commands |
| `*/include/openfc_capture.h` | Capture ring record format |
| `tools/bringup_cli.py` | Flash the RP2350, send commands, field control |
| `tools/publish_firmware.py` | Build the release images for the web flasher and print the manifest entry |
| `devtools/` | Investigation tools; see below |

**Three headers exist twice**, once per PlatformIO project, and must stay byte-identical: `openfc_frames.h`, `openfc_spi_link.h`, `openfc_capture.h`. Check with `diff esp32/include/X rp2350/include/X` after any change. The two engines (`smart_link.cpp` and `smart_link_rp.cpp`) must also keep the same protocol logic; the ESP32 copy's comments are the reference.

## Building

PlatformIO, from each project directory. If `pio` isn't on your PATH, `python -m platformio` works the same.

```
cd esp32  && pio run        # bench build: .pio/build/esp32-s3-devkitc-1/{bootloader,partitions,firmware}.bin
cd rp2350 && pio run        # bench build: .pio/build/rpipico2/firmware.bin
pio run -e release          # (in either project) release build: .pio/build/release/
```

There are two flavours, from the same source:

- **Bench** (the default env) has the development tools compiled in: bus capture and the A↔B relay (`OPENFC_DEVTOOLS=1`). Use it on the bench.
- **Release** (`-e release`, `OPENFC_DEVTOOLS=0`) leaves them out. That returns the capture rings' RAM (128 KB on the ESP32, 256 KB on the RP2350), removes the relay's blocking loop, and makes `capture`/`relay` answer `unknown_command`. **Only release builds go on the website**; `publish_firmware.py` builds them itself.

`bu_hello` reports which flavour is running as `devtools: true/false`. New dev-only features belong in `devtools.cpp` (ESP32) or behind `#if OPENFC_DEVTOOLS` (RP2350), hooked into `main.cpp` the same way.

The version string lives in `esp32/platformio.ini` (`OPENFC_FW_VERSION`) and is what `bu_hello` reports. The RP2350 has no version of its own; always flash both MCUs from the same build, because they share the frame and SPI definitions.

## Flashing

**ESP32**, over the CH340:

```
cd esp32 && pio run -t upload
```

**RP2350**, through the ESP32's SWD bridge (the RP2350 has no USB or BOOTSEL path on this board):

```
cd tools
py bringup_cli.py --port COM3 flash-rp2350 ../rp2350/.pio/build/rpipico2/firmware.bin
py bringup_cli.py --port COM3 cmd '{"cmd":"rp2350_spi","op":"ping"}'
```

The CLI and the web flasher check that every 384-byte chunk arrives whole and that the final byte count matches the image. A short image leaves the RP2350 in its bootrom (SWD answers, SPI doesn't).

**Publishing** to the web flasher: `py tools/publish_firmware.py` builds the `release` env of both projects, writes the merged ESP32 image and the RP2350 image into `public/firmware/`, and prints the `v13_releases` entry to add to `public/firmware/manifest.json`. The flasher offers the entry with the newest `released` date. Check the published hello says `"devtools":false`.

## How the Smart-port engine works

The engine was rebuilt in 0.1.4 from a relay recording of a real VEX field controller talking to a V5 controller through this board (see *Relay* below). The controller leads every exchange; the engine answers each controller frame exactly once, with the frame the field controller sent in that position, and sends nothing unprompted:

| Controller | Engine |
|---|---|
| `0A 4B` announce | `FC_REPLY1` |
| `13 20` + controller ID | `FC_SESSION_ACK` |
| `11` enumeration request | `ENUM_04` |
| `02 04`, `02 54` | `02 02 01 …` (`build_fc_ack(0x02)`) |
| first `A7`/`A0` after `02 04` | `ENUM_54` with byte 3 = `00` |
| `A3` | `02 A3 01 …` (`build_fc_ack(0xA3)`) |
| `A7`/`A0` in session | `53` state frame or `02 A7` |

In session: a `53` on every mode change; while enabled, `53` with the live ms countdown on 4 frames of 5 and `02 A7` on the fifth; while disabled, `02 A7`. The controller echoes its mode in `A7` byte 6, and until the echo matches, the engine re-sends the `53` every other frame.

Things that are deliberately **not** in the engine any more, because the recording showed the field controller doesn't do them: sending `13 20` or `A3` itself, answering an announce with a reply pair, cold/warm announce gating, timed enumeration fallbacks, a free-running transmit tick, and the software replug. Field mode (`A7`) does not need a robot; the old "interlock" is now opt-in (`field_engage {interlock:true}`).

Both MCUs boot engaged and Disabled, and the ESP32 releases the RP2350 from reset at the end of `setup()`.

## Rules that keep the engines' timing intact

The A/B engines share the ESP32 loop with everything else, and a controller expects an answer within about a millisecond. Anything that blocks the loop disturbs ports A and B.

- **SPI to the RP2350:** field set and status time out after 30 ms, and polling drops to every 2 s while the RP2350 is unreachable. Use long timeouts only for diagnostic commands.
- **RP2350 recovery** (after three failed requests) must not block: a 0.5 ms `RUN` pulse, then no SPI for 300 ms, backing off from 5 s to 60 s.
- **Serial:** 2 KB TX and RX buffers. The RX buffer has to hold a whole ~550-byte `rp2350_flash_data` line while the engines run.
- **RP2350 flash sessions** pause SPI polling and recovery from `rp2350_flash_begin` until the session ends; the RP2350 is halted in between.
- The **RP2350 SPI slave** re-initialises the PL022 after any transaction whose TX FIFO state is uncertain; a byte left in the FIFO shifts every later result.

## Dev tools (`devtools/`)

Python, needs `pyserial`; every script takes `--port` (default `COM3`) and explains itself with `--help`.

| Script | Board | What it does |
|---|---|---|
| `watch.py [--reset]` | any build | Listen without sending anything; with `--reset`, reboot first to check the boot default |
| `state_walk.py [--port-letter B]` | any build | Walk disabled → driver → auton → disabled → driver → disabled with a banner per step |
| `port_map.py` | any build | Move a controller between jacks; prints the order ports linked in |
| `capture.py` | bench build | Hold a state on the chosen ports while recording every byte, then dump to JSON lines |
| `relay.py` | bench build | Record a real field controller through ports A and B |
| `summarize.py FILE` | none | Frame types per port and direction, which bytes vary, examples |
| `timeline.py FILE` | none | `--handshake`: the exchange frame by frame; `--states`: state frames against the controller's echo; `--relay` for relay recordings |

They share `_common.py`, which reuses the serial helpers from `tools/bringup_cli.py`.

## Bench checks

With a V5 controller and no robot, from `devtools/`:

1. **Boot:** plug the controller into any Smart port, then `py watch.py --reset`. The port should show `link=True fm=2` with `pack` climbing within about 2 s, no RP2350 resets, and the controller should show Disabled.
2. **State walk:** `py state_walk.py`. The controller's indicator should follow each step, including both returns to disabled.
3. **Repeat on the other MCU's ports.** Jacks, bottom to top: B, A, D, C (`py port_map.py` to re-check).
4. **Capture** (bench build): `py capture.py --ports B --state driver --secs 20 --out cap.jsonl`, then `py summarize.py cap.jsonl`. The ESP32 ring holds about 25 s of one port in session.

## Relay

To learn more of the protocol from a real field controller (bench build): put the field controller on one of the bottom two jacks and the V5 controller on the other, then from `devtools/`

```
py relay.py --secs 60 --out relay.jsonl
py timeline.py relay.jsonl --relay --handshake
py timeline.py relay.jsonl --relay --states
```

`--field` and `--ctrl` tell `timeline.py` which jack each device was on (defaults A and B).

Power-cycle the controller when it starts so the handshake is recorded. The board passes bytes between A and B through the UART FIFOs and records each burst against the port it arrived on. The robot-link, program-running and signal indicators are still undecoded; a relay run with a robot linked, a program started and stopped, and the brain switched off briefly would show them.

## Known limitations

- A period that ends on C/D first isn't reported back to the ESP32 (the RP2350 already sends its state in `FIELD_STATUS` byte 1; the ESP32 ignores it).
- Each port starts its countdown when its controller first receives the new state.
- The legacy ports have no comms watchdog and don't follow `field_state`.
- On 0.1.4, port A hasn't been bench-tested and port C only for the boot link (same code as B and D).
- The RP2350 builds for a stock Pico 2 board target, not the RP2354A.
