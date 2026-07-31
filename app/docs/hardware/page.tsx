import type { Metadata } from 'next';
import DocsLayout, { Note, Section, T, Table } from '@/components/docs/DocsLayout';
import { REPO_URL } from '@/lib/site';

// Hardware reference. Pin map and constants mirror firmware/src/openfc_pins.h,
// which is the normative source.

// Published design files, served from public/hardware/. Sizes are stated so a
// visitor knows what a download costs before starting one; the 3D model and
// outline are zipped because both are large plain-text formats.
const HARDWARE_FILES = [
  {
    href: '/hardware/openfc-v1-gerbers.zip',
    label: 'Gerbers and drill files',
    format: 'RS-274X + Excellon, zip',
    size: '98 KB',
  },
  {
    href: '/hardware/openfc-v1-schematic.pdf',
    label: 'Schematic',
    format: 'PDF',
    size: '308 KB',
  },
  {
    href: '/hardware/openfc-v1-bom.xlsx',
    label: 'Bill of materials',
    format: 'XLSX',
    size: '9 KB',
  },
  {
    href: '/hardware/openfc-v1-pick-and-place.xlsx',
    label: 'Pick and place',
    format: 'XLSX',
    size: '11 KB',
  },
  {
    href: '/hardware/openfc-v1-3d-step.zip',
    label: '3D model',
    format: 'STEP, zip',
    size: '2.6 MB',
  },
  {
    href: '/hardware/openfc-v1-outline-dxf.zip',
    label: 'Board outline',
    format: 'DXF, zip',
    size: '220 KB',
  },
  {
    href: '/hardware/openfc-v1-easyeda-project.eprj2',
    label: 'EasyEDA Pro project',
    format: 'EPRJ2',
    size: '1.3 MB',
  },
];

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
          The full design is published under <T>CERN-OHL-P-2.0</T> — free to
          manufacture, modify and sell. See the{' '}
          <a href="/docs/license" className="text-blue-400 hover:underline">
            license
          </a>
          . The board was drawn in EasyEDA Pro; the gerbers below are what the
          fabricator needs and are readable by any CAM tool.
        </p>
        <Table
          head={['File', 'Format', 'Size']}
          rows={HARDWARE_FILES.map((f) => [
            <a
              key={f.href}
              href={f.href}
              download
              className="text-blue-400 hover:underline"
            >
              {f.label}
            </a>,
            <T key={`${f.href}-f`}>{f.format}</T>,
            f.size,
          ])}
        />
        <p>
          Fabrication was ordered from the gerber archive as-is: 4 layers, 1.6 mm
          FR-4, 1 oz copper, HASL. The pick-and-place and BOM files are formatted
          for JLCPCB assembly.
        </p>
        <Note>
          The <T>.eprj2</T> project file only opens in EasyEDA Pro. Everything
          needed to build the board without it — gerbers, drills, BOM,
          placement, outline and 3D model — is listed above.
        </Note>
        <p>
          Sources are versioned alongside the firmware at{' '}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            {REPO_URL.replace('https://', '')}
          </a>
          .
        </p>
      </Section>

      <Section id="disclaimer" title="Not VEX hardware">
        <p>
          OpenFC is an independent open-source project of Elevation Robotics. It
          is not manufactured, endorsed, approved or sponsored by VEX Robotics
          or the REC Foundation, and is not affiliated with either. Those names
          appear here only to describe what the board is compatible with.
        </p>
      </Section>
    </DocsLayout>
  );
}
