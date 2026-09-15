import type { Metadata } from 'next';
import Link from 'next/link';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
  Table,
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
            <Link href="/docs/v1_3" className="text-blue-400 hover:underline">
              V1.3 dual-MCU board
            </Link>{' '}
            — the ESP32-S3 + RP2350 prototype: two-step flashing and the
            inter-MCU protocols.
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

      <Section id="match" title="A complete match that survives a reconnect">
        <p>
          The examples above start one period. A real match runs autonomous,
          a pause, then driver — and your software may crash, be restarted or
          lose the cable in the middle. Send a{' '}
          <Link href="/docs/protocol#tokens" className="text-blue-400 hover:underline">
            period token
          </Link>{' '}
          (<T>match_id</T> + <T>period_seq</T>) and the board&apos;s{' '}
          <T>device_id</T> with every <T>start_period</T>, and recovery is
          simply: reopen the port and send the same command again. The board
          sorts out what that means.
        </p>
        <Table
          head={['Board replies', 'Meaning', 'Your software does']}
          rows={[
            [
              <T key="a">ack</T>,
              'Period started — or was already running under this token.',
              'Wait for timer_expired with this period_seq.',
            ],
            [
              <>
                <T>error</T> <T>period_complete</T>
              </>,
              'This period finished while you were away.',
              'Move on to the next period.',
            ],
            [
              <>
                <T>error</T> <T>timer_active</T>
              </>,
              'A different period is running (another host, or a stale token).',
              'Stop and surface it to the operator.',
            ],
            [
              <>
                <T>error</T> <T>wrong_device</T>
              </>,
              'This is not the board you started the match on.',
              'Stop — you have the wrong port.',
            ],
          ]}
        />
        <Code label="python — full match, safe to restart at any point">{`import json, time, uuid, serial

PORT = 'COM3'
MATCH_ID = uuid.uuid4().hex[:16]          # any string up to 32 chars; persist it if
                                          # your process may restart mid-match
PERIODS = [(1, 'auto', 15000), (2, 'driver', 105000)]   # (period_seq, mode, ms)
GAP_S = 3

def open_port():
    while True:
        try:
            p = serial.Serial(PORT, 115200, timeout=0.1)
            p.dtr = p.rts = True
            return p
        except serial.SerialException:
            time.sleep(0.5)               # unplugged or re-enumerating; keep trying

port = open_port()

def send(**kw):
    port.write((json.dumps(kw) + '\\n').encode())

def events():
    """Yield parsed JSON lines; reopen the port if it drops."""
    global port
    while True:
        try:
            line = port.readline().decode(errors='replace').strip()
        except serial.SerialException:
            port.close(); port = open_port()
            yield {'evt': '_reconnected'}
            continue
        if line.startswith('{'):
            try: yield json.loads(line)
            except ValueError: pass

def identify():
    send(cmd='get_info')
    for evt in events():
        if evt.get('evt') == 'hello':
            return evt['device_id']

device_id = identify()

def run_period(seq, mode, duration_ms):
    """Returns when this period is over, however many reconnects it takes."""
    def start():
        send(cmd='start_period', mode=mode, duration_ms=duration_ms,
             match_id=MATCH_ID, period_seq=seq, device_id=device_id)
    start()
    for evt in events():
        kind = evt.get('evt')
        if kind == '_reconnected':
            start()                       # replay: a no-op if still running
        elif kind == 'timer_expired' and evt.get('period_seq') == seq:
            return evt['reason']          # 'timer' or 'ended'
        elif kind == 'error' and evt.get('cmd') == 'start_period':
            if evt['reason'] == 'period_complete':
                return 'complete'         # finished while we were disconnected
            raise SystemExit(f"{evt['reason']}: refusing to continue")
        elif kind == 'estop' and evt.get('source') != 'timer':
            raise SystemExit(f"e-stop ({evt['source']})")

try:
    for i, (seq, mode, ms) in enumerate(PERIODS):
        print(mode, run_period(seq, mode, ms))
        if i < len(PERIODS) - 1:
            time.sleep(GAP_S)
finally:
    send(cmd='estop')                     # always leave the field disabled`}</Code>
        <p>
          Two details make this safe. The board refuses to run a retired token
          again, so a replay after the period ended can never re-enable the
          robots; and <T>estop</T> is never gated on tokens or binding, so the
          operator can always stop the field. If your process itself may be
          restarted mid-match, persist <T>MATCH_ID</T> and the current{' '}
          <T>period_seq</T> to disk, then on startup send{' '}
          <T>get_timer</T> — <T>timer_state</T> carries the running token, or{' '}
          <T>last_match_id</T> / <T>last_period_seq</T> if the period already
          finished.
        </p>
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
            <T>timer_active</T> — a period is already running. The full list of
            reasons is on the{' '}
            <Link href="/docs/protocol#errors" className="text-blue-400 hover:underline">
              protocol page
            </Link>
            .
          </li>
          <li>
            <strong>Expect the port to vanish.</strong> A replug re-enumerates
            the CH340; the path (COM number, <T>/dev/ttyUSB*</T>) usually comes
            back the same but is not guaranteed. Retry the open in a loop, then
            replay your last <T>start_period</T> as above.
          </li>
          <li>
            <strong>Check the firmware before a real event.</strong> Compare{' '}
            <T>fw_hash</T> from <T>hello</T> with the{' '}
            <Link href="/docs/api" className="text-blue-400 hover:underline">
              published hashes
            </Link>{' '}
            and refuse to run if it is not a certified release.
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
