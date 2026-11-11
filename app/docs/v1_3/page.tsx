import type { Metadata } from 'next';
import Link from 'next/link';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
  Table,
} from '@/components/docs/DocsLayout';

// V1.3 dual-MCU board: architecture, field control, the Smart-port protocol,
// flashing, and the bring-up wire protocol. Pin and protocol facts mirror
// firmware-bringup-v1_3/esp32/include/openfc_pins_v13.h,
// firmware-bringup-v1_3/rp2350/include/openfc_pins_rp2350.h,
// firmware-bringup-v1_3/esp32/include/openfc_frames.h and
// firmware-bringup-v1_3/esp32/src/main.cpp, which are normative.

export const metadata: Metadata = {
  title: 'V1.3 dual-MCU board — OpenFC',
  description:
    'OpenFC V1.3: ESP32-S3 plus RP2350 Smart-port expander. Field control on four Smart ports, the Smart-port protocol, flashing both MCUs, and bus capture.',
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
          Smart ports next to the four legacy Competition-Switch ports. A V5
          controller plugged into a Smart port gets its match state directly,
          and shows it at the top of its screen. Two of the Smart ports live on
          a second MCU, so the board carries two firmware images and is
          flashed in two steps. This page describes firmware{' '}
          <T>0.1.6-bringup</T>.
        </>
      }
    >
      <Note kind="warn">
        Prototype hardware and bring-up firmware. The V1.3 images speak the{' '}
        <T>bu_*</T> bring-up protocol, not the certified match protocol, and
        are not certified for competition. The production{' '}
        <L href="/docs/protocol">serial protocol</L> applies to hardware
        revision 1.1 boards.
      </Note>

      <Section id="architecture" title="Architecture">
        <Table
          head={['', 'ESP32-S3 (host)', 'RP2350 (Serial Expander)']}
          rows={[
            ['Part', <T key="a">ESP32-S3-WROOM, 8 MB flash</T>, <T key="b">RP2354A, flash-in-package</T>],
            ['Talks to the PC', 'USB via CH340C, JSON lines at 115200', '— (no USB wired)'],
            ['Legacy V5 ports', '4 × RJ11, driven in unison', '—'],
            ['Smart ports', 'A, B (RS-485, 1.6 Mbaud)', 'C, D (RS-485, 1.6 Mbaud)'],
            ['Link', 'SPI master, 1 MHz, mode 1', 'SPI slave (PL022 on spi0)'],
            ['Programmed by', 'esptool over the CH340', 'The ESP32, over on-board SWD'],
          ]}
        />
        <p>
          The PC only ever talks to the ESP32. Each MCU runs its own
          Smart-port engines: A and B on the ESP32, C and D on the RP2350. The
          ESP32 forwards the field state to the RP2350 over SPI and polls its
          port status five times a second, so a host sees all four ports in one
          event without needing to know which MCU owns which.
        </p>
      </Section>

      <Section id="ports" title="Ports and pins">
        <p>
          The Smart-port jacks are unlabelled on the REV A board. Bottom to top
          (measured 2026-09-26 by moving a controller between them):
        </p>
        <Table
          head={['Jack', 'Port', 'MCU']}
          rows={[
            ['Bottom', <T key="p">B</T>, 'ESP32-S3'],
            ['2nd from bottom', <T key="p">A</T>, 'ESP32-S3'],
            ['3rd from bottom', <T key="p">D</T>, 'RP2350'],
            ['Top', <T key="p">C</T>, 'RP2350'],
          ]}
        />
        <p>
          The four legacy RJ11 ports share one ENABLE/DISABLE line (
          <T>IO47</T>) and one DRIVER/AUT line (<T>IO48</T>), with the same
          polarity as revision 1.1, so any of them can be used.
        </p>
        <Table
          head={['Smart port', 'MCU', 'TX', 'RX', 'DE']}
          rows={[
            ['A', 'ESP32-S3', <T key="a">IO17</T>, <T key="b">IO18</T>, <T key="c">IO4</T>],
            ['B', 'ESP32-S3', <T key="a">IO15</T>, <T key="b">IO16</T>, <T key="c">IO5</T>],
            ['C', 'RP2350', <T key="a">GPIO0</T>, <T key="b">GPIO1</T>, <T key="c">GPIO2</T>],
            ['D', 'RP2350', <T key="a">GPIO4</T>, <T key="b">GPIO5</T>, <T key="c">GPIO6</T>],
          ]}
        />
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
        <p>
          The RP2350&apos;s <T>QSPI_SS</T>/BOOTSEL and USB pins are
          unconnected, so its USB bootloader is unreachable: SWD from the
          ESP32 is the only programming path.
        </p>
      </Section>

      <Section id="field-control" title="Field control">
        <p>
          The board boots with field control engaged and Disabled, and
          releases the RP2350 from reset at boot. A V5 controller plugged into
          any Smart port links within about two seconds and shows Disabled at
          the top of its screen, with no host connected. No robot is needed
          for the controller to show the field state.
        </p>
        <p>
          A host changes the state with <T>field_state</T> (<T>disabled</T>,{' '}
          <T>driver</T> or <T>auton</T>). The state applies to all four Smart
          ports; the controller follows within one status frame (about 20 ms).
          From 0.1.6, <T>driver</T> or <T>auton</T> starts a timed period on
          the board, and the board keeps it running if the host goes away: the
          robots keep their state until the period ends. The host should still
          send a <T>ping</T> about once a second while engaged.
        </p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Match timer.</strong> The board times each period from the{' '}
            <T>field_state</T> that starts it, using that mode&apos;s{' '}
            <T>field_period</T> (default 105 s driver and 15 s auton). Sending
            the running state again does not restart it, and a{' '}
            <T>field_period</T> sent mid-period applies to the next period, not
            the running one. When it runs out the
            board disables every port, the legacy ports included, and reports{' '}
            <T>bu_match_end</T> with <T>reason</T> <T>timer</T>. A host that
            reconnects reads the period back from <T>bu_field</T>:{' '}
            <T>timed</T> and <T>remaining_ms</T>.
          </li>
          <li>
            <strong>Controller countdown.</strong> Each Smart port also counts
            the period down from the moment its controller first receives the
            new state, and sends the remaining time with every state frame. If
            a port reaches zero before the board&apos;s timer, it ends the
            period the same way, with <T>reason</T> <T>port</T>.
          </li>
          <li>
            <strong>Reconnect.</strong> A host that reconnects mid-period sends{' '}
            <T>get_info</T>. For the next second, the first{' '}
            <T>field_state</T> <T>disabled</T> and the first{' '}
            <T>legacy_set</T> off are answered but not applied: the reply says{' '}
            <T>disabled</T> with <T>held</T> <T>true</T>, and the robots keep
            their state. This absorbs Competition Control&apos;s reconnect
            sequence, which disables before it looks at its match. The next{' '}
            <T>bu_field</T> reports the real state; a second disable applies at
            once.
          </li>
          <li>
            <strong>Host watchdog.</strong> Outside a timed period, a host that
            commands driver or auton must send a <T>ping</T> (or any field
            command) at least every 2.5 s, or the board drops back to Disabled
            and reports <T>bu_field_watchdog</T>.
          </li>
          <li>
            <strong>Robot name.</strong> Each port in <T>bu_field</T> reports{' '}
            <T>robot</T>, the name the controller carries in bytes 18–23 of its
            status frame. It is free text set by the team (usually the team
            number) and at most six characters, so match it against the teams
            in the match rather than trusting it outright.
          </li>
          <li>
            <strong>Legacy ports.</strong> These follow <T>legacy_set</T>{' '}
            only. They are not driven by <T>field_state</T>, so a host running a
            match on both kinds of port has to command both. The end of a timed
            period disables them too.
          </li>
          <li>
            <strong>Diagnostics.</strong> While engaged the engines own the
            Smart ports. Send <T>{'{"cmd":"field_engage","on":false}'}</T>{' '}
            before the <T>rs485_*</T> commands or the relay, and{' '}
            <T>{'{"on":true}'}</T> afterwards.
          </li>
        </ul>
        <p>
          The <L href="/field">practice match page</L> runs matches on a V1.3
          board. For each period it sends <T>field_period</T>,{' '}
          <T>field_state</T> and <T>legacy_set</T>, so robots on the Smart
          ports and the legacy ports run together, and pings four times a
          second. It ends every period itself, disabling both kinds of port;
          from 0.1.6 the board also ends it on its own timer if the page goes
          away. The match
          screen&apos;s footer lists the linked Smart ports and their robot
          names.
        </p>
        <p>
          In <T>bu_field</T>, each port reports <T>link</T> (the session is
          up), <T>fm</T> (the controller&apos;s status stream: 2 = field mode,
          1 = joystick-only, 0 = none) and <T>pack</T> (status frames
          received, about 50 a second in session). A healthy port shows{' '}
          <T>link:true</T>, <T>fm:2</T> and <T>pack</T> climbing.
        </p>
      </Section>

      <Section id="smart-protocol" title="Smart-port protocol">
        <p>
          The engines are modelled on a recording of a real VEX field
          controller talking to a V5 controller through this board (2026-09-27,
          see <a href="#relay" className="text-blue-400 hover:underline">Relay</a>).
          The controller leads every exchange. The field controller answers
          each controller frame exactly once, about 0.4 ms later, and sends
          nothing unprompted. Frames are 16 or 32 bytes with a CRC-16/CCITT-FALSE
          over all but the last two bytes.
        </p>
        <Table
          head={['Controller sends', 'Board answers', 'Stage']}
          rows={[
            [<T key="c">0A 4B … (announce, about once a second)</T>, <T key="r">03 0A 64 00 00 00 00 BA 00 9D 68 5E 00 00 84 75</T>, 'Handshake'],
            [<T key="c">13 20 00 00 xx xx xx … (its 3-byte ID)</T>, <T key="r">02 13 01 … 01 … F3 78</T>, 'Session ack'],
            [<T key="c">11 (enumeration request)</T>, <T key="r">04 00 14 …</T>, 'Enumeration'],
            [<T key="c">02 04</T>, <T key="r">02 02 01 …</T>, 'Enumeration'],
            [<T key="c">A7 (first status frame)</T>, <T key="r">54 09 00 00 C9 36 B8 50 58 39 00 EE FE …</T>, 'Enumeration'],
            [<T key="c">02 54</T>, <T key="r">02 02 01 …</T>, 'Enumeration'],
            [<T key="c">A3 17 …</T>, <T key="r">02 A3 01 …</T>, 'Enumeration'],
            [<T key="c">A7 / A0 at 50 Hz</T>, <T key="r">53 state frame, or 02 A7 ack</T>, 'Session'],
          ]}
        />
        <p>
          In session the board sends a <T>53</T> state frame on every change.
          While enabled it sends <T>53</T> with the live countdown on four
          frames out of five and <T>02 A7</T> on the fifth; while disabled it
          sends <T>02 A7</T>. The controller echoes its mode back, and while
          the echo does not match the commanded state the board re-sends the{' '}
          <T>53</T> every other frame, so a single missed frame cannot leave
          the controller on the wrong state. A controller that announces while
          in session has dropped it and starts over.
        </p>
        <Table
          head={['53 byte', 'Meaning']}
          rows={[
            ['1', <><T>C9</T> disabled, <T>E1</T> driver, <T>D1</T> auton</>],
            ['4–6', 'Remaining time in ms, 24-bit little-endian (0 while disabled)'],
            ['8', <T key="v">03</T>],
          ]}
        />
        <Table
          head={['Controller A7 byte', 'Meaning (from the recording)']}
          rows={[
            ['3', <><T>10</T> disabled, <T>30</T> enabled (echo)</>],
            ['6', <><T>40</T> before enumeration, then the mode byte (echo)</>],
            ['7', 'Seconds remaining (echo)'],
            ['16', 'Rose from 50 to 81 over the first ~1.7 s of the session, then held'],
            ['17', <><T>06</T> with no robot linked; probably robot-link status, not yet confirmed</>],
            ['18–23', 'Name'],
          ]}
        />
        <p>
          Robot-link, program-running and signal-strength indicators have not
          been decoded yet: the recording was made with no robot linked. A
          relay recording with a robot connected, a program started and
          stopped, and the brain switched off for a few seconds would show
          which bytes carry them.
        </p>
        <Note>
          Firmware before 0.1.4 used a model reverse-engineered from a V5
          brain, which sent the controller&apos;s own <T>13 20</T> and{' '}
          <T>A3</T> frames itself and assumed field mode needed a radio-linked
          robot. Controllers on it stayed in joystick-only mode (<T>fm:1</T>).
        </Note>
      </Section>

      <Section id="status-leds" title="Status LEDs">
        <p>
          The three SK6812 LEDs show the state the board is driving, painted by
          the firmware. Exactly one LED is lit:
        </p>
        <Table
          head={['LED', 'Colour', 'Lit when']}
          rows={[
            ['0', 'Red', 'Disabled'],
            ['1', 'Amber', 'Autonomous'],
            ['2', 'Green', 'Driver'],
          ]}
        />
        <p>
          The Smart-port field state takes priority while it is driver or
          auton; otherwise the legacy ports decide. The LEDs switch before the
          ports do on <T>field_state</T>, <T>field_engage</T>,{' '}
          <T>legacy_set</T> and <T>legacy_raw</T>, and follow the board&apos;s
          own transitions: watchdog, match end and boot (red).{' '}
          <T>identify</T> takes the LEDs over for 3 s. <T>led_set</T> still
          works for testing and holds until the state next changes.{' '}
          <T>bu_hello</T> carries <T>{'"leds":"field"'}</T>; a host that sees
          it must not paint the LEDs itself.
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
            the <L href="/flash">standard flasher</L>. The board reboots and
            answers <T>get_info</T> with <T>bu_hello</T>. About 30 seconds.
          </li>
          <li>
            <strong>RP2350.</strong> The browser streams the image to the ESP32
            as base64 JSON commands over the live serial link, and the ESP32
            programs the RP2350 over SWD: probe, erase, 384-byte chunks each
            acknowledged with a running byte count, then a reboot into the new
            image. About 10 seconds for a 53 KB image. The flasher stops if any
            chunk arrives short.
          </li>
        </ol>
        <p>
          Step 2 is only enabled once the board has identified itself with{' '}
          <T>bu_hello</T>, which is why the ESP32 is flashed first. Afterwards{' '}
          <strong>SPI ping</strong> should report the RP2350 answering. To test
          a local build, open <em>Flash a custom build instead</em> on either
          step: the merged image for the ESP32, the raw <T>firmware.bin</T>{' '}
          for the RP2350. Flash both MCUs from the same release; the two
          firmwares share the SPI link and frame definitions.
        </p>
      </Section>

      <Section id="builds" title="Bench and release builds">
        <p>
          Each firmware builds in two flavours from the same source. The
          default PlatformIO environment is the <strong>bench</strong> build,
          with the development tools compiled in: bus capture and the relay.
          The <T>release</T> environment leaves them out, which returns the
          capture rings&apos; RAM (128 KB on the ESP32, 256 KB on the RP2350)
          and removes the relay&apos;s blocking loop. The web flasher only ever
          gets release builds: <T>tools/publish_firmware.py</T> builds the{' '}
          <T>release</T> environment of both projects itself.{' '}
          <T>bu_hello</T> reports which one is running as{' '}
          <T>devtools</T>; on a release build the <T>capture</T> and{' '}
          <T>relay</T> commands answer <T>unknown_command</T>.
        </p>
        <Code label="firmware-bringup-v1_3/esp32 (same in rp2350)">{`pio run                 # bench build (default env)
pio run -e release      # release build, what the web flasher gets`}</Code>
      </Section>

      <Section id="cli" title="Command-line tools">
        <p>
          <T>firmware-bringup-v1_3/tools/bringup_cli.py</T> (needs{' '}
          <T>pyserial</T>) covers flashing the RP2350, sending commands and
          field control. The investigation tools are in{' '}
          <T>firmware-bringup-v1_3/devtools/</T>: <T>capture.py</T>,{' '}
          <T>relay.py</T>, <T>summarize.py</T>, <T>timeline.py</T>,{' '}
          <T>state_walk.py</T>, <T>port_map.py</T> and <T>watch.py</T>; each
          explains itself with <T>--help</T>. Build both images with
          PlatformIO first.
        </p>
        <Code label="firmware-bringup-v1_3/">{`cd esp32  && pio run -t upload          # ESP32-S3 over the CH340
cd ../rp2350 && pio run                  # produces .pio/build/rpipico2/firmware.bin
cd ../tools
py bringup_cli.py --port COM3 flash-rp2350 ../rp2350/.pio/build/rpipico2/firmware.bin
py bringup_cli.py --port COM3 cmd '{"cmd":"rp2350_spi","op":"ping"}'
py bringup_cli.py --port COM3 engage --state driver --secs 30`}</Code>
        <p>
          <T>tools/publish_firmware.py</T> builds both release images, merges
          the ESP32 image, copies both into <T>public/firmware/</T> and prints
          the <T>v13_releases</T> manifest entry the web flasher reads.
        </p>
      </Section>

      <Section id="commands" title="Bring-up commands">
        <p>
          JSON lines at 115200 over the CH340, one <T>{'{"cmd":…}'}</T> object
          per line. Every event carries an <T>evt</T> field. Commands have
          plain names; the board&apos;s events are prefixed <T>bu_</T> (except{' '}
          <T>ack</T>) so a host can tell this firmware from the production
          firmware, which answers the same <T>get_info</T> with{' '}
          <T>hello</T>.
        </p>
        <Table
          head={['Command', 'Reply', 'Notes']}
          rows={[
            [<T key="c">get_info</T>, <T key="r">bu_hello</T>, 'fw_version, hw_version, device_id, leds, devtools'],
            [<T key="c">ping</T>, <T key="r">ack</T>, 'Feeds the field watchdog'],
            [<T key="c">{'field_engage {on,interlock}'}</T>, <T key="r">bu_field</T>, 'Engaged at boot. on:false hands the Smart ports back for diagnostics; on:true re-engages Disabled. interlock:true holds driver/auton until the controller is in field mode'],
            [<T key="c">{'field_state {state}'}</T>, <T key="r">bu_field</T>, <><T>disabled</T> / <T>driver</T> / <T>auton</T>, all Smart ports</>],
            [<T key="c">{'field_period {driver,auton}'}</T>, <T key="r">bu_field</T>, 'Period lengths in ms (defaults 105000 / 15000)'],
            [<T key="c">{'legacy_set {enable,mode}'}</T>, <T key="r">bu_legacy_state</T>, <>Legacy ports; mode <T>driver</T> or <T>auto</T></>],
            [<T key="c">{'legacy_raw {ed,ad}'}</T>, <T key="r">bu_legacy_state</T>, 'Raw pin levels, diag=true'],
            [<T key="c">{'capture {ports,on,stream}'}</T>, <T key="r">bu_cap_status</T>, 'Bench builds. Record every Smart-port byte both ways; see Bus capture'],
            [<T key="c">{'capture {dump:true}'}</T>, <T key="r">bu_cap…, bu_cap_status</T>, 'Bench builds. Stop and send what is held'],
            [<T key="c">{'relay {ms,hold_us}'}</T>, <T key="r">bu_relay_result</T>, 'Bench builds. Pass bytes between ports A and B and record them; see Relay'],
            [<T key="c">{'rs485_raw / rs485_listen / rs485_selftest / rs485_crosstest / rs485_linktest'}</T>, <T key="r">bu_rs485_rx, bu_*_result</T>, 'Ports A/B wiring diagnostics; disengage first'],
            [<T key="c">{'rp2350_ctrl {run,boot_ctrl}'}</T>, <T key="r">bu_rp2350_state</T>, 'Drive the RP2350 RUN and BOOT_CTRL lines'],
            [<T key="c">{'rp2350_spi {op,port,de,bytes}'}</T>, <T key="r">bu_spi_result, bu_rs485_rx</T>, <>op <T>ping</T>, or <T>rs485_raw</T> on C/D while disengaged</>],
            [<T key="c">{'rp2350_swd_probe / rp2350_flash_*'}</T>, <T key="r">bu_swd_probe, bu_flash_status</T>, 'See RP2350 flash commands'],
            [<T key="c">{'led_set {index,r,g,b}'}</T>, <T key="r">ack</T>, 'Manual colour, held until the status changes'],
            [<T key="c">identify</T>, <T key="r">ack</T>, '3 s RGB flash on all LEDs'],
          ]}
        />
        <p>
          Unprompted events: <T>bu_state</T> (1 Hz heartbeat with buttons,{' '}
          <T>rp2350</T> reachability and <T>rp2350_resets</T>),{' '}
          <T>bu_field</T> (1 Hz while engaged), <T>bu_field_watchdog</T>,{' '}
          <T>bu_match_end</T> and <T>bu_rp2350_reset</T> (the ESP32 reset an
          RP2350 that stopped answering). Errors arrive as <T>bu_error</T>{' '}
          with a <T>reason</T>.
        </p>
      </Section>

      <Section id="capture" title="Bus capture">
        <p>
          Bench builds only. <T>capture</T> records every byte the engines read from or write to
          the chosen Smart ports — announces, enumeration, the 50 Hz status
          stream and the board&apos;s own replies — with the port, direction
          and a microsecond timestamp. A/B record on the ESP32 (128 KB), C/D on
          the RP2350 (256 KB). One port in session fills about 5 KB/s, so the
          ESP32 ring holds roughly 25 s of one port. A full ring drops new
          records and counts them in <T>dropped</T>, so a capture keeps its
          beginning, which is where the handshake is.
        </p>
        <p>
          Records are held on the board and sent on <T>dump</T> as one{' '}
          <T>bu_cap</T> line each, then <T>bu_cap_status</T> with{' '}
          <T>done:true</T>. Ports C/D come out only while disengaged, because
          pulling them over SPI stalls the ESP32; if the status still shows C/D
          bytes held, dump again after disengaging. <T>stream:true</T> also
          sends A/B live as far as 115200 baud allows. <T>t</T> is the owning
          MCU&apos;s clock, so timings compare within a port but not across
          MCUs.
        </p>
        <Code label="One record">{`{"evt":"bu_cap","p":"B","d":"rx","t":1234567,"h":"0A4B000009000040..."}`}</Code>
        <Code label="firmware-bringup-v1_3/devtools/">{`py capture.py --ports B --state driver --secs 20 --out cap.jsonl
py summarize.py cap.jsonl                 # frame types per port and direction, which bytes vary, examples
py timeline.py cap.jsonl --port B --states   # state frames against the controller's echo`}</Code>
        <p>
          The bring-up console&apos;s Bus capture panel does the same and
          downloads the result as JSON lines.
        </p>
      </Section>

      <Section id="relay" title="Relay: recording a real field controller">
        <p>
          Bench builds only. The board can sit between a VEX field controller and a V5
          controller, one on port A and the other on port B, and pass every
          byte across while recording it. Bytes arriving on a port came from
          the device plugged into it, so the recording separates the two sides.
          The engines stay off and the board originates nothing. It reads and
          writes the UART FIFOs directly, adding roughly a byte time (about
          6 µs) each way, and switches each side&apos;s driver on only while
          forwarding (released <T>hold_us</T>, default 40, after the last
          byte). A 60 s run on 2026-09-27 held a full session through the
          relay with nothing dropped.
        </p>
        <Code label="firmware-bringup-v1_3/devtools/">{`py relay.py --secs 60 --out relay.jsonl
py timeline.py relay.jsonl --relay --handshake   # the exchange, frame by frame
py timeline.py relay.jsonl --relay --states      # state frames against the controller's echo`}</Code>
        <p>
          <T>relay.py</T> disengages the field first and re-engages it after. The board sends nothing over USB
          until the relay ends, then dumps the recording. Power-cycle the
          controller at the start so the handshake is recorded.
        </p>
      </Section>

      <Section id="swd-protocol" title="RP2350 flash commands">
        <p>
          Four bring-up commands carry the RP2350 image. All replies are{' '}
          <T>bu_flash_status</T> events with a <T>stage</T> field; wait for each
          reply before sending the next command. While a session is open the
          ESP32 stops polling the RP2350 and suspends its automatic reset.
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
                Appends up to 384 raw bytes (base64-encoded). <T>received</T> is
                the running byte count; a host must check it grew by the chunk
                length, since a line that loses characters can still decode.
              </>,
            ],
            [
              <T key="c">{'{"cmd":"rp2350_flash_end"}'}</T>,
              <T key="r">stage:&quot;end&quot;</T>,
              <>
                Programs the last partial page, flushes the XIP cache, and
                pulses <T>RUN</T> so the new image boots. <T>received</T> must
                equal the image size.
              </>,
            ],
          ]}
        />
        <p>
          On failure <T>ok</T> is <T>false</T> and <T>fail</T> names the stage
          (e.g. <T>halt</T>, <T>reset_halt</T>, <T>no_session</T>,{' '}
          <T>bad_b64</T>). The ESP32 bit-bangs SWD, under the ~250 kHz ceiling
          that applies while a blank RP2350 waits in its bootrom.
        </p>
      </Section>

      <Section id="spi-link" title="ESP32 ↔ RP2350 SPI link">
        <p>
          Fixed 37-byte frames in both directions (4-byte header, 32-byte
          payload, 8-bit sum checksum), 1 MHz, <strong>SPI mode 1</strong>{' '}
          (CPOL=0, CPHA=1). The ESP32 is always master; because the slave
          cannot push a reply, every command is followed by a{' '}
          <T>GET_RESULT</T> poll, repeated while the status byte is{' '}
          <T>PENDING</T>.
        </p>
        <Table
          head={['Byte', 'Request (ESP32 → RP2350)', 'Result (RP2350 → ESP32)']}
          rows={[
            ['0', 'cmd', 'status (0 pending, 1 ok, 2 error, 0xFF idle)'],
            ['1', 'port (‘C’ / ‘D’ / 0)', 'port (echoed)'],
            ['2', 'flags (bit0 = DE for rs485_raw)', 'flags'],
            ['3', 'payload length (0–32)', 'payload length'],
            ['4–35', 'payload', 'payload'],
            ['36', 'checksum', 'checksum'],
          ]}
        />
        <Table
          head={['Command', 'Payload']}
          rows={[
            [<T key="c">FIELD_SET 0x06</T>, 'engaged, state (0/1/2), driver_ms LE32, auton_ms LE32, interlock, seq'],
            [<T key="c">FIELD_STATUS 0x07</T>, 'Result: engaged, state, then per port C and D: link, fm, pack (LE16), link acks, replugs, name (6 bytes); then the seq of the last field set applied'],
            [<T key="c">CAPTURE 0x08</T>, 'op (0 stop, 1 start, 2 status), port mask; result: used, size, dropped, records'],
            [<T key="c">CAPTURE_READ 0x09</T>, 'Result: next ≤ 32 bytes of the capture stream; flags bit0 = more'],
            [<T key="c">PING 0x01, RS485_RAW 0x02</T>, 'Link check; raw send or listen on C/D while disengaged'],
          ]}
        />
        <p>
          Field set and status are answered on the first poll (about 6 ms), and
          the ESP32 waits at most 30 ms for them, so an absent RP2350 cannot
          stall ports A/B. After three failed requests in a row the ESP32
          pulses <T>RUN</T>, backing off from 5 s to 60 s while the RP2350 keeps
          failing, and re-sends the field state once it answers.
        </p>
        <p>
          A request the RP2350 drops is invisible to the ESP32: the next poll
          reads back the previous result, which is also OK. So each field set
          carries a sequence number, and the ESP32 re-sends the field state
          whenever the status poll reports a different one. A missed state
          change on C/D is corrected within one poll (200 ms).
        </p>
        <Note kind="warn">
          Mode 1 is required: the RP2350&apos;s PL022 slave with CPHA=0 and CS
          held low for a whole frame captures only the first byte. Keep the two
          copies of <T>openfc_spi_link.h</T>, <T>openfc_frames.h</T> and{' '}
          <T>openfc_capture.h</T> identical.
        </Note>
      </Section>

      <Section id="status" title="What is verified">
        <Table
          head={['Subsystem', 'Status']}
          rows={[
            ['Legacy port polarity', 'Confirmed against a live V5 (2026-09-01).'],
            ['Field control, port B', 'Controller links and shows Disabled ~2 s after boot with no host; followed disabled → driver → auton → disabled → driver → disabled (2026-09-27, 0.1.4).'],
            ['Field control, port D', 'Same walk, on the RP2350 over SPI, with the name reported through FIELD_STATUS (2026-09-27, 0.1.4).'],
            ['Field control, port C', 'Links and reaches field mode after boot with no host (2026-09-27, 0.1.4); state walk not yet run.'],
            ['Field control, port A', 'Not yet tested on 0.1.4. Same engine code as B.'],
            ['Status LEDs', 'Red, green and amber follow disabled, driver and auton (2026-09-26).'],
            ['Relay', '60 s session between a VEX field controller and a V5 controller, nothing dropped (2026-09-27).'],
            ['Bus capture', 'A/B and C/D rings recorded and dumped on the bench (2026-09-26).'],
            ['ESP32 → RP2350 flashing over SWD', 'About 10 s for a 53 KB image, including while field control is engaged.'],
            ['Match end, watchdog, robot-link indicators', 'Not yet tested on hardware.'],
          ]}
        />
      </Section>

      <Section id="limitations" title="Known limitations">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            A period that ends on ports C/D&apos;s own countdown first is not
            reported back to the ESP32; A/B, the legacy ports and the LEDs stay
            enabled until the board&apos;s period timer ends it.
          </li>
          <li>
            Each port starts its countdown when its controller first receives
            the new state, so ports that link at different times can end a
            few frames apart.
          </li>
          <li>
            The legacy ports have no comms watchdog: outside a timed period, a{' '}
            <T>legacy_set</T> enable stays live if the host goes away, and they
            do not follow <T>field_state</T>.
          </li>
          <li>
            While a timed period runs the board cannot be stopped from the host
            if the host is gone: the robots keep their state until the period
            ends. A host that reconnects stops them with its second disable,
            or with its first one sent more than a second after{' '}
            <T>get_info</T>.
          </li>
          <li>
            The capture ring fills in about 25 s of one port in session, and
            the relay blocks the board for its whole duration.
          </li>
          <li>
            The RP2350 board target is a stock Pico 2, not the RP2354A; it
            works, but the flash size in its build is not the part&apos;s.
          </li>
        </ul>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <Table
          head={['Symptom', 'Likely cause']}
          rows={[
            [
              <>Controller shows nothing, or <T>fm</T> stays 1</>,
              <>
                Firmware older than 0.1.4, or the port is disengaged. Check{' '}
                <T>bu_hello</T> and send{' '}
                <T>{'{"cmd":"field_engage","on":true}'}</T>. If it still does not
                link, power-cycle the controller.
              </>,
            ],
            [
              <>Controller drops in and out of its state</>,
              <>
                The ESP32 loop is being stalled. Check <T>bu_state</T> for a
                climbing <T>rp2350_resets</T>: an RP2350 that is not answering
                (often a bad image) is reset repeatedly. Reflash the RP2350.
              </>,
            ],
            [
              <>SPI ping fails after a flash</>,
              <>
                Check the flash reported <T>received</T> equal to the image size;
                a short image leaves the RP2350 in its bootrom. Reflash from the
                same release as the ESP32.
              </>,
            ],
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
                RP2350 held in reset: send{' '}
                <T>{'{"cmd":"rp2350_ctrl","run":true}'}</T> (the flasher does
                this). If it still fails, check the 33 Ω resistors on
                SWCLK/SWDIO.
              </>,
            ],
            [
              <><T>fail:&quot;reset_halt&quot;</T> at begin</>,
              <>The reset catch missed. Retry.</>,
            ],
            [
              <><T>rs485_*</T> or relay refused with <T>field_engaged</T></>,
              <>
                The board boots engaged. Send{' '}
                <T>{'{"cmd":"field_engage","on":false}'}</T> first.
              </>,
            ],
          ]}
        />
      </Section>
    </DocsLayout>
  );
}
