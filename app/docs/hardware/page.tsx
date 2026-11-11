import type { Metadata } from 'next';
import Link from 'next/link';
import DocsLayout, { Note, Section, T, Table } from '@/components/docs/DocsLayout';
import { REPO_URL } from '@/lib/site';

// Hardware reference for both board revisions. V1.1 pin map and constants
// mirror firmware/src/openfc_pins.h, which is the normative source; V1.3 pins
// and firmware are on /docs/v1_3.

// Published design files, served from public/hardware/. Sizes are stated so a
// visitor knows what a download costs before starting one; the 3D model and
// outline are zipped because both are large plain-text formats.
const V1_1_FILES = [
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

// V1.3 REV A as exported from Altium Designer for fabrication and assembly.
const V1_3_FILES = [
  {
    href: '/hardware/openfc-v1_3-gerbers.zip',
    label: 'Gerbers and drill files',
    format: 'RS-274X + Excellon, zip',
    size: '1.7 MB',
  },
  {
    href: '/hardware/openfc-v1_3-bom.xlsx',
    label: 'Bill of materials',
    format: 'XLSX',
    size: '19 KB',
  },
  {
    href: '/hardware/openfc-v1_3-pick-and-place.csv',
    label: 'Pick and place',
    format: 'CSV',
    size: '32 KB',
  },
  {
    href: '/hardware/openfc-v1_3-top.png',
    label: 'Assembly render, top',
    format: 'PNG',
    size: '240 KB',
  },
  {
    href: '/hardware/openfc-v1_3-bottom.png',
    label: 'Assembly render, bottom',
    format: 'PNG',
    size: '133 KB',
  },
];

export const metadata: Metadata = {
  title: 'Hardware — OpenFC',
  description:
    'OpenFC hardware reference: the V1.1 and V1.3 field controller boards for VEX V5, their design files, pin maps and build notes.',
};

function FileTable({ files }: { files: { href: string; label: string; format: string; size: string }[] }) {
  return (
    <Table
      head={['File', 'Format', 'Size']}
      rows={files.map((f) => [
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
  );
}

export default function HardwareDocs() {
  return (
    <DocsLayout
      title="Hardware"
      active="/docs/hardware"
      intro={
        <>
          Two board revisions are published. <strong>V1.1</strong> is an
          ESP32-S3 driving four VEX V5 Competition Switch ports through
          optocouplers; most of this page describes it. <strong>V1.3</strong>{' '}
          adds an RP2350 and four RS-485 Smart ports; its hardware and design
          files are <a href="#v1_3" className="text-blue-400 hover:underline">below</a>,
          and its pins, firmware and protocols are on{' '}
          <Link href="/docs/v1_3" className="text-blue-400 hover:underline">
            V1.3 dual-MCU board
          </Link>
          . Both are published under <T>CERN-OHL-P-2.0</T>.
        </>
      }
    >
      <Section id="overview" title="V1.1 overview">
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

      <Section id="pins" title="V1.1 pin map">
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

      <Section id="timing" title="V1.1 firmware constants">
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

      <Section id="building" title="Building the V1.1 firmware">
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

      <Section id="files" title="V1.1 design files">
        <p>
          The full design is published under <T>CERN-OHL-P-2.0</T> — free to
          manufacture, modify and sell. See the{' '}
          <a href="/docs/license" className="text-blue-400 hover:underline">
            license
          </a>
          . The board was drawn in EasyEDA Pro; the gerbers below are what the
          fabricator needs and are readable by any CAM tool.
        </p>
        <FileTable files={V1_1_FILES} />
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

      <Section id="v1_3" title="V1.3 board">
        <p>
          Board <T>Open_FC_V1_3 REV A</T> (BOM and placement files:{' '}
          <T>PN 001 REV 003</T>). The ESP32-S3 talks to the PC and runs the
          legacy ports and Smart ports A/B; the RP2350 runs Smart ports C/D and
          is programmed by the ESP32-S3 over SWD. Pin maps, firmware, flashing
          and the Smart-port protocol are on{' '}
          <Link href="/docs/v1_3" className="text-blue-400 hover:underline">
            V1.3 dual-MCU board
          </Link>
          .
        </p>
        <Table
          head={['', '']}
          rows={[
            ['Host MCU', <T key="m">ESP32-S3-WROOM-1-N8</T>],
            ['Smart-port MCU', <T key="r">RP2354A</T>],
            ['USB bridge', <T key="u">CH340C</T>],
            ['Legacy ports', '4, driven in unison; PC817C optocoupler per signal (8 total)'],
            ['Smart ports', <>4 × RS-485, <T key="t">THVD2450</T> transceiver per port</>],
            ['Status LEDs', '3 addressable RGB (STATUS, BLE, CONTROL)'],
            ['Buttons', 'BOOT, RESET, IO12, IO13; slide power switch'],
            ['Power', <>USB-C, <T key="c">TP4056</T> battery charging on a 2-pin JST XH, <T key="p">TPS2116</T> power mux, 3.3 V LDO</>],
            ['Header', '6-pin: RX, GND, TX, DIO, GND, CLK'],
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          {/* Plain <img>: the static export has no image optimizer. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/hardware/openfc-v1_3-top.png"
            alt="OpenFC V1.3 REV A assembly render, top side"
            width={1281}
            height={866}
            className="h-auto w-full rounded-lg border border-gray-800"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/hardware/openfc-v1_3-bottom.png"
            alt="OpenFC V1.3 REV A assembly render, bottom side"
            width={1281}
            height={866}
            className="h-auto w-full rounded-lg border border-gray-800"
          />
        </div>
      </Section>

      <Section id="v1_3-files" title="V1.3 design files">
        <p>
          Exported from Altium Designer for fabrication and assembly, and
          published under <T>CERN-OHL-P-2.0</T> like V1.1.
        </p>
        <FileTable files={V1_3_FILES} />
        <p>
          REV A was ordered from these files with SMT assembly from JLCPCB: 4
          layers (top, GND, PWR, bottom), 1.6 mm FR-4, 1 oz outer and 0.5 oz
          inner copper, 123.4 × 84.8 mm. The pick-and-place file lists 185
          placements, 174 on the top side and 11 on the bottom.
        </p>
        <Note>
          The Altium project and a schematic PDF for V1.3 are not published
          yet. Everything a fabricator needs to build the board — gerbers,
          drills, BOM and placement — is listed above.
        </Note>
      </Section>

      <Section id="disclaimer" title="Not VEX hardware">
        <p>
          VEX, VEX Robotics and V5 are trademarks of Innovation First, Inc.
          (IFI). OpenFC is an independent open-source project of Elevation
          Robotics and is not affiliated with, manufactured, endorsed, approved
          or sponsored by Innovation First, Inc., VEX Robotics or the Robotics
          Education &amp; Competition Foundation (RECF). Those names appear here
          only to describe what the board is compatible with.
        </p>
      </Section>
    </DocsLayout>
  );
}
