import type { Metadata } from 'next';
import Link from 'next/link';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
  Table,
} from '@/components/docs/DocsLayout';

// V1.3 dual-MCU board: architecture, the two-step flashing procedure, and
// the bring-up wire protocol behind it. Pin and protocol facts mirror
// firmware-bringup-v1_3/esp32/include/openfc_pins_v13.h,
// firmware-bringup-v1_3/rp2350/include/openfc_pins_rp2350.h and
// firmware-bringup-v1_3/esp32/src/main.cpp, which are normative.

export const metadata: Metadata = {
  title: 'V1.3 dual-MCU board — OpenFC',
  description:
    'OpenFC V1.3: ESP32-S3 plus RP2350 Smart-port expander. How to flash both MCUs from the browser, and the SPI/SWD protocols between them.',
};

const L = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="text-blue-400 hover:underline">
    {children}
  </Link>
);

export default function V13Docs() {
  return (
    <DocsLayout
      title="V1.3 dual-MCU board"
      active="/docs/v1_3"
      intro={
        <>
          The V1.3 revision (<T>Open_FC_V1_3 REV A</T>) adds four RS-485 VEX
          Smart ports next to the four legacy Competition-Switch ports. Two of
          the Smart ports live on a second MCU, so the board carries two
          firmware images and is flashed in two steps.
        </>
      }
    >
      <Note kind="warn">
        Prototype hardware and bring-up firmware. The V1.3 images published on
        this site are diagnostic builds — they speak the <T>bu_*</T> bring-up
        protocol, not the certified match protocol, and are not certified for
        competition. The production <L href="/docs/protocol">serial protocol</L>{' '}
        applies to hardware revision 1.1 boards.
      </Note>

      <Section id="architecture" title="Architecture">
        <Table
          head={['', 'ESP32-S3 (host)', 'RP2350 (Serial Expander)']}
          rows={[
            ['Part', <T key="a">ESP32-S3-WROOM, 8 MB flash</T>, <T key="b">RP2354A, flash-in-package</T>],
            ['Talks to the PC', 'USB CDC via CH340C, JSON lines at 115200', '— (no USB wired)'],
            ['Legacy V5 ports', '4 × RJ11, driven in unison', '—'],
            ['Smart ports', 'A, B (RS-485, direct)', 'C, D (RS-485, direct)'],
            ['Link', 'SPI master, 1 MHz, mode 1', 'SPI slave (PL022 on spi0)'],
            ['Programmed by', 'esptool over the CH340', 'The ESP32, over on-board SWD'],
          ]}
        />
        <p>
          The PC only ever talks to the ESP32. Anything for ports C or D is
          proxied over the SPI link, and results come back tagged with the
          port letter so a host does not need to know which MCU owns a port.
          The field-control engine for C/D runs on the RP2350 itself; the
          ESP32 forwards the engage/state commands and polls status.
        </p>
      </Section>

      <Section id="pins" title="Inter-MCU pin map">
        <Table
          head={['Signal', 'ESP32-S3', 'RP2350', 'Notes']}
          rows={[
            ['SPI CS', <T key="a">IO10</T>, <T key="b">GPIO17</T>, 'Active low'],
            ['SPI MOSI', <T key="a">IO11</T>, <T key="b">GPIO16</T>, 'ESP32 → RP2350'],
            ['SPI SCLK', <T key="a">IO12</T>, <T key="b">GPIO18</T>, 'Through R38'],
            ['SPI MISO', <T key="a">IO13</T>, <T key="b">GPIO19</T>, 'RP2350 → ESP32'],
            ['RP2350_IRQ', <T key="a">IO21</T>, <T key="b">GPIO8</T>, 'RP2350 has a result ready'],
            ['RP2350_RUN', <T key="a">IO6</T>, <T key="b">RUN</T>, 'Active-low reset, 10 K pull-up (R39)'],
            ['BOOT_CTRL', <T key="a">IO7</T>, <T key="b">GPIO20</T>, 'Spare GPIO — not BOOTSEL'],
            ['ESP_READY', <T key="a">IO40</T>, <T key="b">GPIO10</T>, 'ESP32 has booted'],
            ['SWCLK', <T key="a">IO42</T>, <T key="b">SWCLK</T>, '33 Ω series (R58)'],
            ['SWDIO', <T key="a">IO41</T>, <T key="b">SWDIO</T>, '33 Ω series (R59)'],
          ]}
        />
        <Table
          head={['Smart port', 'MCU', 'TX', 'RX', 'DE']}
          rows={[
            ['A', 'ESP32-S3', <T key="a">IO17</T>, <T key="b">IO18</T>, <T key="c">IO4</T>],
            ['B', 'ESP32-S3', <T key="a">IO15</T>, <T key="b">IO16</T>, <T key="c">IO5</T>],
            ['C', 'RP2350', <T key="a">GPIO0</T>, <T key="b">GPIO1</T>, <T key="c">GPIO2</T>],
            ['D', 'RP2350', <T key="a">GPIO4</T>, <T key="b">GPIO5</T>, <T key="c">GPIO6</T>],
          ]}
        />
        <p>
          Legacy ports use <T>IO47</T> (ENABLE/DISABLE) and <T>IO48</T>{' '}
          (DRIVER/AUT), shared across all four RJ11s, with the same polarity as
          revision 1.1. The RP2350&apos;s <T>QSPI_SS</T>/BOOTSEL and USB pins are
          unconnected, so its USB mass-storage bootloader is unreachable: SWD
          from the ESP32 is the only programming path.
        </p>
      </Section>

      <Section id="flashing" title="Flashing from the browser">
        <p>
          Open the <L href="/flash/v1_3">V1.3 flasher</L> in Chrome or Edge,
          connect the board over USB, and run the two steps in order.
        </p>
        <ol className="ml-5 list-decimal space-y-2">
          <li>
            <strong>ESP32-S3.</strong> esptool-js writes the merged image
            (bootloader + partition table + app) at <T>0x0</T>, exactly as on
            the <L href="/flash">standard flasher</L>. The board reboots into
            the new firmware and answers <T>get_info</T> with a{' '}
            <T>bu_hello</T> event. About 30 seconds.
          </li>
          <li>
            <strong>RP2350.</strong> The browser never touches SWD: it streams
            the image to the ESP32 as base64 JSON commands over the live
            serial link, and the ESP32 does the programming. The flasher
            releases <T>RUN</T>, probes SWD, erases, writes 384-byte chunks
            (each acknowledged before the next is sent), then reboots the
            RP2350 into the new image. About 10 seconds for a 53 KB image.
          </li>
        </ol>
        <p>
          Afterwards, <strong>SPI ping</strong> on the flasher (or the RP2350
          panel of the <L href="/bringup-v1_3">bring-up console</L>) should
          report the RP2350 answering. Ports C and D do nothing until it does.
        </p>
        <Note>
          After any ESP32 reflash the RP2350 is held in reset (<T>RUN</T> low)
          until something releases it. The flasher and the CLI do this for you;
          if you drive the protocol yourself, send{' '}
          <T>{'{"cmd":"rp2350_ctrl","run":true}'}</T> before the SWD probe or
          it will report no DPIDR.
        </Note>
        <p>
          Step 2 is only enabled once the connected board has identified itself
          with <T>bu_hello</T>. A board still running production firmware
          ignores the <T>rp2350_*</T> commands, which is why the ESP32 must be
          flashed first.
        </p>
      </Section>

      <Section id="cli" title="Flashing from the command line">
        <p>
          The same sequence is available as a Python tool in the repository
          (needs <T>pyserial</T>). Build both images with PlatformIO first.
        </p>
        <Code label="firmware-bringup-v1_3/">{`cd esp32  && pio run -t upload          # ESP32-S3 over the CH340
cd ../rp2350 && pio run                  # produces .pio/build/rpipico2/firmware.bin
cd ..
py tools/bringup_cli.py --port COM3 flash-rp2350 rp2350/.pio/build/rpipico2/firmware.bin
py tools/bringup_cli.py --port COM3 cmd '{"cmd":"rp2350_spi","op":"ping"}'`}</Code>
        <p>
          <T>tools/publish_firmware.py</T> merges the ESP32 image, copies the
          RP2350 image into <T>public/firmware/</T> and prints the{' '}
          <T>v13_releases</T> manifest entry the web flasher reads.
        </p>
      </Section>

      <Section id="swd-protocol" title="RP2350 flash commands">
        <p>
          Four bring-up commands carry the RP2350 image. All replies are{' '}
          <T>bu_flash_status</T> events with a <T>stage</T> field; wait for each
          reply before sending the next command.
        </p>
        <Table
          head={['Command', 'Reply', 'Meaning']}
          rows={[
            [
              <T key="c">{'{"cmd":"rp2350_swd_probe"}'}</T>,
              <T key="r">bu_swd_probe</T>,
              <>
                Connects and identifies. <T>ok:true</T> with{' '}
                <T>dpidr:&quot;4C013477&quot;</T> and{' '}
                <T>bootrom_magic:&quot;0402754D&quot;</T> means the core is alive.
                Safe at any time.
              </>,
            ],
            [
              <T key="c">{'{"cmd":"rp2350_flash_begin","size":N}'}</T>,
              <T key="r">stage:&quot;begin&quot;</T>,
              <>
                Reset-halts core0, runs the bootrom&apos;s flash init, and erases{' '}
                <T>N</T> bytes rounded up to 4 KB from flash offset 0. The
                RP2350 stays halted until <T>end</T>.
              </>,
            ],
            [
              <T key="c">{'{"cmd":"rp2350_flash_data","b64":"…"}'}</T>,
              <T key="r">stage:&quot;data&quot;</T>,
              <>
                Appends up to 384 raw bytes (base64-encoded). Larger chunks are
                truncated. <T>received</T> is the running byte count.
              </>,
            ],
            [
              <T key="c">{'{"cmd":"rp2350_flash_end"}'}</T>,
              <T key="r">stage:&quot;end&quot;</T>,
              <>
                Programs the last partial page, flushes the XIP cache, and
                pulses <T>RUN</T> so the new image boots. <T>received</T> should
                equal the image size.
              </>,
            ],
          ]}
        />
        <p>
          On failure <T>ok</T> is <T>false</T> and <T>fail</T> names the stage
          that failed (e.g. <T>halt</T>, <T>reset_halt</T>, <T>no_session</T>,{' '}
          <T>bad_b64</T>). The ESP32 bit-bangs SWD, staying under the ~250 kHz
          ceiling that applies while a blank RP2350 waits in its bootrom.
        </p>
        <Code label="Reference sequence (TypeScript, lib/rp2350-flash.ts)">{`send({cmd:'rp2350_ctrl', run:true});            // out of reset
await reply('bu_swd_probe');                    // expect ok:true
send({cmd:'rp2350_flash_begin', size: image.length});
await reply('bu_flash_status', 'begin');
for (let off = 0; off < image.length; off += 384) {
  send({cmd:'rp2350_flash_data', b64: base64(image.subarray(off, off + 384))});
  await reply('bu_flash_status', 'data');       // ok:true, received
}
send({cmd:'rp2350_flash_end'});
await reply('bu_flash_status', 'end');          // ok:true, received === image.length`}</Code>
      </Section>

      <Section id="spi-link" title="ESP32 ↔ RP2350 SPI link">
        <p>
          Fixed 37-byte frames in both directions (4-byte header, 32-byte
          payload, 8-bit sum checksum), 1 MHz, <strong>SPI mode 1</strong>{' '}
          (CPOL=0, CPHA=1). The ESP32 is always master; because the slave
          cannot push a reply, every command is followed by a{' '}
          <T>GET_RESULT</T> poll, repeated while the status byte is{' '}
          <T>PENDING</T> (the <T>RP2350_IRQ</T> line rising means a result is
          ready).
        </p>
        <Table
          head={['Byte', 'Request (ESP32 → RP2350)', 'Result (RP2350 → ESP32)']}
          rows={[
            ['0', 'cmd', 'status (0 pending, 1 ok, 2 error, 0xFF idle)'],
            ['1', 'port (\u2018C\u2019 / \u2018D\u2019 / 0)', 'port (echoed)'],
            ['2', 'flags (bit0 = DE for rs485_raw)', 'flags'],
            ['3', 'payload length (0–32)', 'payload length'],
            ['4–35', 'payload', 'payload'],
            ['36', 'checksum', 'checksum'],
          ]}
        />
        <Note kind="warn">
          Mode 1 is not a preference. The RP2350&apos;s PL022 slave, with CPHA=0
          and CS held low for a whole frame, captures only the first byte and
          clocks 0xFF back for the rest — on the bench every multi-byte
          transaction read as <T>FF FF FF…</T> until both sides moved to
          CPHA=1. Keep the two <T>openfc_spi_link.h</T> copies identical.
        </Note>
        <p>
          Commands over the link: <T>PING</T>, <T>RS485_RAW</T> (send bytes /
          passive listen on C or D), <T>LINKTEST</T> (Smart-port handshake),{' '}
          <T>FIELD_SET</T> and <T>FIELD_STATUS</T> (engage/state and per-port
          link/ack counters). From the PC these are reached through{' '}
          <T>{'{"cmd":"rp2350_spi","op":…}'}</T>; the field-control commands
          fan out to A/B on the ESP32 and C/D on the RP2350 automatically.
        </p>
      </Section>

      <Section id="status" title="What is verified">
        <Table
          head={['Subsystem', 'Status']}
          rows={[
            ['Legacy port polarity', 'Confirmed against a live V5 (2026-09-01).'],
            ['ESP32 → RP2350 flashing over SWD', 'Erase + write + boot of a 53 KB image in ~10 s, repeatable.'],
            ['SPI link', '37/37 bytes per frame, valid checksums, zero re-inits after the mode-1 fix.'],
            ['Smart ports C and D', 'Both held live sessions with VEX controllers in parallel for 45 s at ~50 acks/s, driven by the RP2350 and reported over SPI.'],
            ['Smart ports A and B', 'Same handshake engine, on the ESP32 directly.'],
          ]}
        />
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <Table
          head={['Symptom', 'Likely cause']}
          rows={[
            [
              <>Step 2 disabled, &quot;has not identified itself&quot;</>,
              <>
                The board is not running V1.3 bring-up firmware, or the{' '}
                <T>bu_hello</T> was missed. Click <em>Identify</em>; if nothing
                arrives, run step 1.
              </>,
            ],
            [
              <>SWD probe fails / no DPIDR</>,
              <>
                RP2350 held in reset. Release <T>RUN</T> (the flasher does this
                automatically; the bring-up console has a button). If it still
                fails, check the 33 Ω series resistors on SWCLK/SWDIO.
              </>,
            ],
            [
              <><T>fail:&quot;reset_halt&quot;</T> at begin</>,
              <>
                The reset catch missed. Retry; the flasher pulses <T>RUN</T>{' '}
                itself at the start of every session.
              </>,
            ],
            [
              <>SPI ping says no response after a successful flash</>,
              <>
                Give the RP2350 a moment after boot, then ping again. If it
                persists, confirm both firmwares share the same{' '}
                <T>openfc_spi_link.h</T> and SPI mode 1.
              </>,
            ],
            [
              <>Port C or D shows no bytes with a controller attached</>,
              <>
                The controller has usually gone to sleep — power it back on. A
                controller also sulks after a disengage until power-cycled.
              </>,
            ],
          ]}
        />
      </Section>
    </DocsLayout>
  );
}
