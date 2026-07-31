import type { Metadata } from 'next';
import DocsLayout, { Note, Section, T, Table } from '@/components/docs/DocsLayout';

// Hardware reference. Pin map and constants mirror firmware/src/openfc_pins.h,
// which is the normative source.

export const metadata: Metadata = {
  title: 'Hardware — OpenFC',
  description:
    'OpenFC hardware reference: ESP32-S3 field controller for VEX V5, optically isolated across four competition ports.',
};

export default function HardwareDocs() {
  return (
    <DocsLayout
      title="Hardware"
      active="/docs/hardware"
      intro={
        <>
          An ESP32-S3 driving four VEX V5 Competition Switch ports through
          optocouplers. Hardware revision 1.1.
        </>
      }
    >
      <Section id="overview" title="Overview">
        <Table
          head={['', '']}
          rows={[
            ['MCU', <T key="m">ESP32-S3-WROOM-1-N16R8</T>],
            ['Flash', '16 MB, dio mode'],
            ['USB bridge', <T key="u">CH340C</T> ],
            ['Ports', '4 × RJ11, driven in unison'],
            ['Isolation', 'PC817C optocoupler per signal (8 total)'],
            ['Power', 'USB-C, with TP4056 battery charging'],
          ]}
        />
        <p>
          Every output is optically isolated, so there is no electrical path
          between the V5 and the USB host. The board sinks the V5&apos;s own
          signal lines rather than driving voltage into them.
        </p>
      </Section>

      <Section id="pins" title="Pin map">
        <p>
          Each port carries an ENABLE/DISABLE line and a DRIVER/AUT line. All
          four ports move together.
        </p>
        <Table
          head={['Port', 'ENABLE/DISABLE', 'DRIVER/AUT']}
          rows={[
            ['1', <T key="a">IO7</T>, <T key="b">IO15</T>],
            ['2', <T key="a">IO16</T>, <T key="b">IO17</T>],
            ['3', <T key="a">IO18</T>, <T key="b">IO8</T>],
            ['4', <T key="a">IO19</T>, <T key="b">IO20</T>],
          ]}
        />
        <Table
          head={['Signal', 'HIGH', 'LOW']}
          rows={[
            ['ENABLE/DISABLE', 'Disabled (safe)', 'Enabled'],
            ['DRIVER/AUT', 'Autonomous', 'Driver'],
          ]}
        />
        <Note kind="warn">
          The two signals have opposite safe levels. ENABLE/DISABLE rests HIGH,
          DRIVER/AUT rests LOW. The firmware drives them explicitly rather than
          through one shared polarity.
        </Note>
        <p>
          <T>IO19</T> and <T>IO20</T> are the ESP32-S3 native USB D−/D+ pins,
          used here as ordinary GPIO for port 4. That is why native USB-Serial
          is unavailable and all serial traffic runs over the CH340C on UART0
          (<T>IO43</T>/<T>IO44</T>).
        </p>
      </Section>

      <Section id="timing" title="Firmware constants">
        <Table
          head={['Constant', 'Value', 'Meaning']}
          rows={[
            [
              <T key="c">WATCHDOG_TIMEOUT_MS</T>,
              '600 ms',
              'Manual-mode comms watchdog. Suspended during a timed period.',
            ],
            [
              <T key="c">HEARTBEAT_INTERVAL_MS</T>,
              '1000 ms',
              'Unsolicited heartbeat event interval.',
            ],
            [<T key="c">PERIOD_MIN_MS</T>, '1 ms', 'Shortest timed period.'],
            [
              <T key="c">PERIOD_MAX_MS</T>,
              '600000 ms',
              'Longest timed period (10 minutes).',
            ],
            [
              <T key="c">TWDT_BACKSTOP_MS</T>,
              '10000 ms',
              'Task-watchdog margin past duration_ms; a firmware hang reboots to Disabled.',
            ],
            [
              <T key="c">IDENTIFY_DURATION_MS</T>,
              '3000 ms',
              'Length of the identify indication.',
            ],
          ]}
        />
      </Section>

      <Section id="building" title="Building the firmware">
        <p>
          PlatformIO, with the target and build flags pinned in{' '}
          <T>firmware/platformio.ini</T>.
        </p>
        <Note kind="warn">
          Flash mode must be <T>dio</T>. The N16R8 modules boot-loop the
          second-stage bootloader when flashed with a <T>qio</T> image. The
          setting is pinned in <T>platformio.ini</T> so builds, uploads and
          merged images all inherit it.
        </Note>
        <p>
          <T>ARDUINO_USB_CDC_ON_BOOT</T> must stay <T>0</T>. Mapping{' '}
          <T>Serial</T> to native USB points the firmware at a dead interface on
          this board.
        </p>
      </Section>

      <Section id="files" title="Design files">
        <p>
          The schematic, PCB layout, gerbers and bill of materials are published
          alongside the firmware in the project repository.
        </p>
        <p>
          <a
            href="https://github.com/elevationrobotics/openfc"
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            github.com/elevationrobotics/openfc
          </a>
        </p>
      </Section>

      <Section id="disclaimer" title="Not VEX hardware">
        <p>
          OpenFC is an independent open-source project. It is not manufactured,
          endorsed or approved by VEX Robotics or the RECF, and it is not a
          substitute for official field control at a sanctioned event. It is
          built for practice and scrimmages.
        </p>
      </Section>
    </DocsLayout>
  );
}
