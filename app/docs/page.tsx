import type { Metadata } from 'next';
import Link from 'next/link';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
} from '@/components/docs/DocsLayout';
import { REPO_URL } from '@/lib/site';

// Docs landing + integration guide: enough to drive the board from another
// application without reading the firmware source.

export const metadata: Metadata = {
  title: 'Documentation — OpenFC',
  description:
    'Integrate the OpenFC field controller into your own application: serial protocol, firmware API, and worked examples in Python, Node and the browser.',
};

export default function DocsHome() {
  return (
    <DocsLayout
      title="Documentation"
      active="/docs"
      intro={
        <>
          OpenFC is open hardware, open firmware and an open protocol. Nothing
          here is proprietary — you can build the board, build the firmware, and
          drive it from your own software.
        </>
      }
    >
      <Section id="start" title="Where to start">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <Link href="/docs/protocol" className="text-blue-400 hover:underline">
              Serial protocol
            </Link>{' '}
            — every command and event, and the safety model behind them.
          </li>
          <li>
            <Link href="/docs/api" className="text-blue-400 hover:underline">
              Firmware API
            </Link>{' '}
            — verify a board is running official, competition-certified
            firmware.
          </li>
          <li>
            <Link href="/docs/hardware" className="text-blue-400 hover:underline">
              Hardware
            </Link>{' '}
            — schematic, pin map and build notes.
          </li>
          <li>
            <Link href="/docs/license" className="text-blue-400 hover:underline">
              License
            </Link>{' '}
            — Apache-2.0 for software, CERN-OHL-P-2.0 for hardware; free to
            build, modify and sell.
          </li>
        </ul>
      </Section>

      <Section id="model" title="How integration works">
        <p>
          There is no daemon, no service and no SDK requirement. The board is a
          USB serial device that exchanges JSON lines at 115200 baud. Your
          application opens the port and writes commands.
        </p>
        <p>The only rule that really matters:</p>
        <Note>
          To run a match, use <T>start_period</T>. The board owns the countdown,
          so the match completes even if your application crashes or the cable
          is unplugged. If you instead enable manually with <T>set</T>, you must
          send a command at least every 600 ms or the board disables itself.
        </Note>
      </Section>

      <Section id="python" title="Python">
        <Code label="pip install pyserial">{`import json, serial

port = serial.Serial('COM3', 115200, timeout=0.1)
port.dtr = port.rts = True   # assert both, or neither — see the protocol page

def send(**kw):
    port.write((json.dumps(kw) + '\\n').encode())

def read():
    line = port.readline().decode(errors='replace').strip()
    return json.loads(line) if line.startswith('{') else None

send(cmd='get_info')                                  # identity + fw_hash
send(cmd='start_period', mode='auto', duration_ms=15000)

while True:
    evt = read()
    if not evt:
        continue
    if evt.get('evt') == 'timer_expired':
        print('autonomous complete')
        break
    if evt.get('evt') == 'error':
        raise SystemExit(f"rejected: {evt['reason']}")`}</Code>
      </Section>

      <Section id="node" title="Node.js">
        <Code label="npm install serialport">{`import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });
const lines = port.pipe(new ReadlineParser({ delimiter: '\\n' }));

const send = (obj) => port.write(JSON.stringify(obj) + '\\n');

lines.on('data', (line) => {
  let evt;
  try { evt = JSON.parse(line); } catch { return; }   // ignore boot chatter

  if (evt.evt === 'hello')         console.log('board', evt.device_id, evt.fw_version);
  if (evt.evt === 'timer_expired') console.log('period over');
  if (evt.evt === 'estop')         console.log('disabled:', evt.source);
});

send({ cmd: 'get_info' });
send({ cmd: 'start_period', mode: 'driver', duration_ms: 105000 });`}</Code>
      </Section>

      <Section id="browser" title="Browser (Web Serial)">
        <p>
          Chrome, Edge and Opera can talk to the board directly. This is how
          this site works — no installation, no native code.
        </p>
        <Code label="requires a user gesture and a secure context">{`const port = await navigator.serial.requestPort();
await port.open({ baudRate: 115200 });   // do not set flowControl

const encoder = new TextEncoderStream();
encoder.readable.pipeTo(port.writable);
const writer = encoder.writable.getWriter();
const send = (obj) => writer.write(JSON.stringify(obj) + '\\n');

const decoder = new TextDecoderStream();
port.readable.pipeTo(decoder.writable);
const reader = decoder.readable.getReader();

await send({ cmd: 'start_period', mode: 'auto', duration_ms: 15000 });`}</Code>
        <p>
          Chrome remembers the permission, so{' '}
          <T>navigator.serial.getPorts()</T> can reopen a previously approved
          board without prompting — which is what makes automatic reconnection
          mid-match possible.
        </p>
      </Section>

      <Section id="manual" title="Manual control with a keepalive">
        <p>
          If you need free-running enable rather than a fixed period, you own
          the keepalive. Ping well inside the 600 ms window.
        </p>
        <Code label="python">{`import threading

send(cmd='set', enable=True, mode='driver')

stop = threading.Event()
def keepalive():
    while not stop.wait(0.25):     # 250 ms, comfortably under the 600 ms limit
        send(cmd='ping')

threading.Thread(target=keepalive, daemon=True).start()

# ... on shutdown, always disable explicitly rather than relying on the watchdog
stop.set()
send(cmd='estop')`}</Code>
      </Section>

      <Section id="practices" title="Practical notes">
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong>Always <T>estop</T> on exit.</strong> The watchdog will catch
            a crash, but an explicit disable is immediate.
          </li>
          <li>
            <strong>Ignore non-JSON lines.</strong> The ESP32 bootloader prints
            plain text at reset.
          </li>
          <li>
            <strong>Re-query after reconnecting.</strong>{' '}
            <T>get_info</T> + <T>get_state</T> + <T>get_timer</T> restores your
            view of a match already in progress.
          </li>
          <li>
            <strong>Trust <T>remaining_ms</T>, not your own clock.</strong> The
            board is authoritative; a host-side timer will drift.
          </li>
          <li>
            <strong>Handle <T>error</T> events.</strong> Most rejections are{' '}
            <T>timer_active</T> — a period is already running.
          </li>
        </ul>
      </Section>

      <Section id="source" title="Source">
        <p>
          Firmware, web application, hardware design and this documentation are
          in one repository.
        </p>
        <p>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline"
          >
            {REPO_URL.replace('https://', '')}
          </a>
        </p>
      </Section>
    </DocsLayout>
  );
}
