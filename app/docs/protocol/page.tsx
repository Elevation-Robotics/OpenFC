import type { Metadata } from 'next';
import DocsLayout, {
  Code,
  Note,
  Section,
  T,
  Table,
} from '@/components/docs/DocsLayout';

// Reference for the JSON-lines serial protocol (spec §5, §6). Kept in step with
// firmware/src/main.cpp and openfc_pins.h — those are the normative source.

export const metadata: Metadata = {
  title: 'Serial Protocol — OpenFC',
  description:
    'Complete reference for the OpenFC JSON-lines serial protocol: commands, events, error codes, and the safety model.',
};

export default function ProtocolDocs() {
  return (
    <DocsLayout
      title="Serial protocol"
      active="/docs/protocol"
      intro={
        <>
          The board speaks newline-delimited JSON over USB serial. Anything that
          can open a serial port can drive it — no SDK required. Protocol
          revision <T>2</T>, firmware 1.3.0.
        </>
      }
    >
      <Section id="transport" title="Transport">
        <Table
          head={['Setting', 'Value']}
          rows={[
            ['Baud rate', <T key="b">115200</T>],
            ['Framing', '8 data bits, no parity, 1 stop bit (8N1)'],
            ['Flow control', 'None — do not enable hardware flow control'],
            ['Encoding', 'UTF-8, one JSON object per line, \\n terminated'],
            ['USB bridge', <T key="u">CH340C</T>],
            ['USB VID:PID', <T key="v">1A86:7523</T>],
          ]}
        />
        <p>
          Every line the board sends is a JSON object with an <T>evt</T> field.
          Every line you send is a JSON object with a <T>cmd</T> field. Lines
          that are not valid JSON are ignored, so bootloader chatter at reset
          will not desynchronise a reader.
        </p>
        <Note kind="warn">
          Opening the port with RTS asserted but DTR de-asserted pulls the
          ESP32-S3 into reset via the CH340C auto-reset circuit. Assert both or
          neither. Chrome&apos;s Web Serial default is safe; most native serial
          libraries need this set explicitly.
        </Note>
      </Section>

      <Section id="lifecycle" title="Connection lifecycle">
        <p>
          The board emits <T>hello</T> once at boot. A host that attaches to an
          already-running board has missed it, so the first thing to send is{' '}
          <T>get_info</T>, which re-emits it on demand. The standard opening
          sequence is three queries that fully restore host-side state:
        </p>
        <Code label="resync on connect">{`{"cmd":"get_info"}    -> hello       (identity + firmware hash)
{"cmd":"get_state"}   -> state       (enabled? mode? timed period?)
{"cmd":"get_timer"}   -> timer_state (remaining_ms of any running period)`}</Code>
        <p>
          This is what makes reattaching mid-match safe: the board keeps running
          its countdown across a disconnect, and these three replies tell a
          reconnecting host exactly where the match stands.
        </p>
      </Section>

      <Section id="commands" title="Commands (host → board)">
        <Table
          head={['Command', 'Fields', 'Effect']}
          rows={[
            [
              <T key="c">ping</T>,
              '—',
              'Keepalive. Refreshes the comms watchdog; replies with ack.',
            ],
            [
              <T key="c">get_info</T>,
              '—',
              'Re-emit hello (identity and firmware hash).',
            ],
            [<T key="c">get_state</T>, '—', 'Emit the current state event.'],
            [<T key="c">get_timer</T>, '—', 'Emit timer_state.'],
            [
              <T key="c">set</T>,
              <>
                <T>enable</T> (bool), <T>mode</T> (<T>&quot;driver&quot;</T> |{' '}
                <T>&quot;auto&quot;</T>)
              </>,
              'Manual enable/disable. Governed by the comms watchdog — you must keep pinging. Rejected during a timed period.',
            ],
            [
              <T key="c">start_period</T>,
              <>
                <T>mode</T>, <T>duration_ms</T> (1–600000)
              </>,
              'Atomically enable and start an on-board countdown. Survives host disconnect. Rejected if a period is already running.',
            ],
            [
              <T key="c">estop</T>,
              '—',
              'Immediately disable and cancel any running period. Always accepted.',
            ],
            [
              <T key="c">identify</T>,
              '—',
              'Visual identification for 3 s. Does not affect outputs.',
            ],
            [
              <T key="c">set_pin</T>,
              <>
                <T>pin</T> (int), <T>value</T> (bool)
              </>,
              'Diagnostics only: drive one GPIO directly, bypassing the state machine. Rejected during a timed period.',
            ],
            [<T key="c">get_pins</T>, '—', 'Emit raw output pin levels.'],
          ]}
        />
        <Note kind="warn">
          <T>set_pin</T> bypasses the state machine and can enable robots while
          the reported state still reads <T>DISABLED</T>. It exists for hardware
          bring-up. Use <T>set</T> or <T>start_period</T> in any application.
        </Note>
      </Section>

      <Section id="events" title="Events (board → host)">
        <Table
          head={['Event', 'Fields', 'When']}
          rows={[
            [
              <T key="e">hello</T>,
              <>
                <T>proto</T>, <T>fw_version</T>, <T>hw_version</T>,{' '}
                <T>device_id</T>, <T>fw_hash</T>
              </>,
              'At boot, and in reply to get_info.',
            ],
            [
              <T key="e">state</T>,
              <>
                <T>enable</T>, <T>mode</T>, <T>state</T>, <T>uptime_ms</T>, and
                when a period is running <T>timed</T>, <T>duration_ms</T>,{' '}
                <T>remaining_ms</T>; <T>diag</T> when set_pin owns the outputs
              </>,
              'After any state change, and in reply to get_state.',
            ],
            [
              <T key="e">heartbeat</T>,
              <T key="u">uptime_ms</T>,
              'Every 1000 ms. Absence indicates a dead link.',
            ],
            [
              <T key="e">timer_state</T>,
              <>
                <T>active</T>, and when active <T>mode</T>, <T>duration_ms</T>,{' '}
                <T>remaining_ms</T>, <T>elapsed_ms</T>
              </>,
              'In reply to get_timer.',
            ],
            [
              <T key="e">timer_expired</T>,
              <>
                <T>mode</T>, <T>duration_ms</T>, <T>elapsed_ms</T>
              </>,
              'A timed period reached its full duration.',
            ],
            [
              <T key="e">estop</T>,
              <>
                <T>source</T>: <T>software</T> | <T>watchdog</T> | <T>timer</T>
              </>,
              'Outputs were disabled. Always followed by a state event.',
            ],
            [<T key="e">pins</T>, <T key="p">pins[]</T>, 'In reply to get_pins.'],
            [<T key="e">ack</T>, <T key="c">cmd</T>, 'Command accepted.'],
            [
              <T key="e">error</T>,
              <>
                <T>reason</T>, <T>cmd</T>
              </>,
              'Command rejected.',
            ],
          ]}
        />
      </Section>

      <Section id="states" title="Board states">
        <Table
          head={['State', 'Meaning']}
          rows={[
            [<T key="s">BOOT</T>, 'Powering up. Outputs safe.'],
            [<T key="s">DISABLED</T>, 'Robots disabled. The resting state.'],
            [<T key="s">ENABLED_DRIVER</T>, 'Robots enabled in driver control.'],
            [<T key="s">ENABLED_AUTO</T>, 'Robots enabled in autonomous.'],
            [
              <T key="s">ESTOP_WATCHDOG</T>,
              'Disabled because the host stopped talking. Send set or start_period to leave.',
            ],
          ]}
        />
      </Section>

      <Section id="errors" title="Error reasons">
        <Table
          head={['reason', 'Cause']}
          rows={[
            [
              <T key="r">timer_active</T>,
              <>
                <T>set</T>, <T>start_period</T> or <T>set_pin</T> arrived while a
                timed period owns the outputs. Send <T>estop</T> first.
              </>,
            ],
            [
              <T key="r">invalid_mode</T>,
              <>
                <T>mode</T> was not <T>&quot;driver&quot;</T> or{' '}
                <T>&quot;auto&quot;</T>.
              </>,
            ],
            [
              <T key="r">invalid_duration</T>,
              <>
                <T>duration_ms</T> was missing, not an integer, or outside
                1–600000.
              </>,
            ],
            [
              <T key="r">invalid_pin</T>,
              'The pin is missing, not an integer, or not one of the eight output GPIOs.',
            ],
            [<T key="r">unknown_command</T>, 'Unrecognised cmd value.'],
          ]}
        />
      </Section>

      <Section id="safety" title="Safety model">
        <p>
          There are two independent mechanisms, and which one applies depends on
          how the robots were enabled.
        </p>
        <Table
          head={['', 'Manual (set / set_pin)', 'Timed (start_period)']}
          rows={[
            [
              'Comms watchdog',
              'Active — 600 ms',
              'Suspended for the whole period',
            ],
            [
              'Host must keep pinging',
              'Yes',
              'No — the host may disconnect entirely',
            ],
            [
              'Ends when',
              'Host stops talking, or estop',
              'duration_ms elapses, or estop',
            ],
          ]}
        />
        <p>
          A timed period is deliberately immune to the comms watchdog: a match
          must finish even if the laptop sleeps or the cable is pulled. The
          countdown is owned by the board, not the host. Backing that up, an
          on-chip task watchdog is armed to <T>duration_ms + 10 s</T>, so a
          firmware hang reboots the chip into the disabled state rather than
          leaving robots live.
        </p>
        <p>
          Outside a timed period the opposite is true: anything that enables the
          robots requires the host to keep sending commands at least every{' '}
          600 ms, or the board disables itself and reports{' '}
          <T>&#123;&quot;evt&quot;:&quot;estop&quot;,&quot;source&quot;:&quot;watchdog&quot;&#125;</T>.
          Send <T>ping</T> every 250 ms; any command resets the timer.
        </p>
        <p>
          The board boots into <T>DISABLED</T> with the enable lines held at
          their safe level, so a power cycle or reset can never enable robots.
        </p>
      </Section>

      <Section id="example" title="A complete match">
        <Code label="host → board, board → host">{`>>> {"cmd":"get_info"}
<<< {"evt":"hello","proto":2,"fw_version":"1.3.0","hw_version":"1.1",
     "device_id":"openfc-494274","fw_hash":"0217fc0d..."}

>>> {"cmd":"start_period","mode":"auto","duration_ms":15000}
<<< {"evt":"state","enable":true,"mode":"auto","state":"ENABLED_AUTO",
     "timed":true,"duration_ms":15000,"remaining_ms":15000,"uptime_ms":41230}
<<< {"evt":"ack","cmd":"start_period"}

    ... 15 s later, with no host traffic required ...

<<< {"evt":"timer_expired","mode":"auto","duration_ms":15000,"elapsed_ms":15000}
<<< {"evt":"estop","source":"timer","uptime_ms":56230}
<<< {"evt":"state","enable":false,"mode":"driver","state":"DISABLED",...}

>>> {"cmd":"start_period","mode":"driver","duration_ms":105000}
    ... driver control runs ...

>>> {"cmd":"estop"}
<<< {"evt":"estop","source":"software","uptime_ms":98120}`}</Code>
      </Section>

      <Section id="pins" title="Output pin map">
        <p>
          All four ports are driven in unison through optocouplers. Each V5
          Competition Switch port carries two signals. Polarity differs between
          them, which is why the safe level is not the same for both.
        </p>
        <Table
          head={['Port', 'ENABLE/DISABLE (ED)', 'DRIVER/AUT (AD)']}
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
      </Section>
    </DocsLayout>
  );
}
