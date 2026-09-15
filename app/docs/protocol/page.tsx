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
          revision <T>3</T>, firmware 1.4.0.
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

      <Section id="tokens" title="Period tokens">
        <p>
          Losing the host mid-match is normal, not exceptional — the page
          reloads, the operator reopens it, the cable is replugged. The problem
          that creates is that a reconnecting host cannot tell the board
          &quot;this is the period you are already running&quot; without the
          board hearing &quot;start a new one&quot;. Protocol 3 fixes that with
          a token: <T>match_id</T> (opaque, up to 32 characters) plus{' '}
          <T>period_seq</T>, sent on <T>start_period</T> and carried by{' '}
          <T>resync</T> and <T>end_period</T>.
        </p>
        <Table
          head={['start_period arrives', 'Board does']}
          rows={[
            ['No period running, unused token', 'Starts the period.'],
            [
              'Period running, same token',
              'Nothing. Acks and re-sends state. The countdown and the outputs are untouched — a replay is not a restart.',
            ],
            [
              'Period running, different token',
              <>
                Rejects with <T>timer_active</T>. A running match is never
                silently preempted.
              </>,
            ],
            [
              'Token of a finished period, or an earlier one of the same match',
              <>
                Rejects with <T>period_complete</T>.
              </>,
            ],
            ['No token at all', 'Protocol-2 behaviour, unchanged.'],
          ]}
        />
        <Note kind="warn">
          The board remembers completed tokens and will not run one again,
          including after an <T>estop</T>. Without that, a host that died just
          before expiry could reconnect, see no active period, replay its{' '}
          <T>start_period</T> and re-enable the robots after the match was over.
          Retirement is per match and covers every <T>period_seq</T> at or below
          the highest one completed, so finishing the driver period also closes
          the auto period before it. A new period always needs a new{' '}
          <T>period_seq</T>, and sequence numbers must increase within a match.
        </Note>
        <p>
          <strong>Binding to a board.</strong> Every OpenFC enumerates under the
          same USB name, so on a multi-field event an operator can select the
          wrong port — and a token cannot catch it, because the token is
          perfectly valid, just meant for another field. Send the board&apos;s{' '}
          <T>device_id</T> from <T>hello</T> alongside the token and a mismatch
          is rejected with <T>wrong_device</T> before anything moves. Binding is
          sticky: a period started with a <T>device_id</T> can only be resynced
          or ended by commands that also carry one. <T>estop</T> is never gated
          on any of this.
        </p>
        <p>
          <strong>Correcting drift.</strong> <T>resync</T> adjusts the deadline
          of the running period and nothing else — it never enables, disables,
          changes mode or re-fires a start. Shortening is unrestricted;
          extending is capped at 2000 ms, because the board&apos;s clock is the
          more trustworthy of the two. <T>millis()</T> runs off the 40 MHz
          crystal and drifts on the order of 12 ms across a two-minute period,
          whereas a backgrounded browser tab has its timers throttled. A host
          asking for a large extension has a wrong clock, not a longer match.
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
                <T>mode</T>, <T>duration_ms</T> (1–600000), optional{' '}
                <T>match_id</T>, <T>period_seq</T>, <T>device_id</T>
              </>,
              'Atomically enable and start an on-board countdown. Survives host disconnect. Rejected if a different period is already running; replaying the token of the running one is a no-op.',
            ],
            [
              <T key="c">resync</T>,
              <>
                <T>match_id</T>, <T>period_seq</T>, <T>remaining_ms</T>,
                optional <T>device_id</T>
              </>,
              'Correct the running period’s deadline. Never touches the outputs. Acks with the applied delta_ms.',
            ],
            [
              <T key="c">end_period</T>,
              <>
                <T>match_id</T>, <T>period_seq</T>, optional <T>device_id</T>
              </>,
              'End the running period early — an operator abort, reported distinguishably from a fault.',
            ],
            [
              <T key="c">estop</T>,
              '—',
              'Immediately disable and cancel any running period. Always accepted — never gated on a token or device_id.',
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
                <T>remaining_ms</T>, plus <T>match_id</T>, <T>period_seq</T>,{' '}
                <T>bound</T> if it is tokenised; <T>diag</T> when set_pin owns
                the outputs
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
                <T>active</T>; when active <T>mode</T>, <T>duration_ms</T>,{' '}
                <T>remaining_ms</T>, <T>elapsed_ms</T> and any{' '}
                <T>match_id</T>, <T>period_seq</T>, <T>bound</T>; when idle,{' '}
                <T>last_match_id</T> and <T>last_period_seq</T> — the match
                that most recently finished a period, and the highest{' '}
                <T>period_seq</T> retired within it (every seq at or below it is
                refused)
              </>,
              'In reply to get_timer.',
            ],
            [
              <T key="e">timer_expired</T>,
              <>
                <T>mode</T>, <T>duration_ms</T>, <T>elapsed_ms</T>,{' '}
                <T>reason</T>: <T>timer</T> | <T>ended</T>; plus the token if
                the period had one
              </>,
              'A timed period finished — either by reaching its duration or via end_period.',
            ],
            [
              <T key="e">estop</T>,
              <>
                <T>source</T>: <T>software</T> | <T>watchdog</T> | <T>timer</T>
              </>,
              'Outputs were disabled. Always followed by a state event. Not emitted for end_period, which is not a fault.',
            ],
            [
              <T key="e">pins</T>,
              <>
                <T>pins[]</T> of <T>{'{pin, label, value}'}</T>
              </>,
              'In reply to get_pins. One entry per output: GPIO number, label (e.g. "AD1", "ED1") and true when driven HIGH.',
            ],
            [
              <T key="e">ack</T>,
              <>
                <T>cmd</T>; <T>delta_ms</T> on a resync
              </>,
              'Command accepted.',
            ],
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
                timed period owns the outputs. Send <T>estop</T> first. A{' '}
                <T>start_period</T> replaying the running period&apos;s own token
                is exempt — that is a no-op, not a rejection.
              </>,
            ],
            [
              <T key="r">wrong_device</T>,
              <>
                The <T>device_id</T> is not this board&apos;s, or the period is
                bound and the command carried none.
              </>,
            ],
            [
              <T key="r">token_mismatch</T>,
              <>
                <T>resync</T> or <T>end_period</T> did not name the period that
                is running — or nothing is running at all.
              </>,
            ],
            [
              <T key="r">period_complete</T>,
              <>
                <T>start_period</T> reused the token of a period that already
                finished, or one at or below the match&apos;s highest completed{' '}
                <T>period_seq</T>. Use a new, higher <T>period_seq</T>.
              </>,
            ],
            [
              <T key="r">invalid_token</T>,
              <>
                <T>match_id</T> and <T>period_seq</T> were not both present, or{' '}
                <T>match_id</T> was empty or over 32 characters.
              </>,
            ],
            [
              <T key="r">resync_out_of_range</T>,
              <>
                <T>resync</T> tried to extend the period by more than 2000 ms.
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
                1–600000; or <T>resync</T> sent a <T>remaining_ms</T> that was
                missing or not a non-negative integer.
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
              'duration_ms elapses, or end_period, or estop',
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
<<< {"evt":"hello","proto":3,"fw_version":"1.4.0","hw_version":"1.1",
     "device_id":"openfc-494274","fw_hash":"0217fc0d..."}

>>> {"cmd":"start_period","mode":"auto","duration_ms":15000,
     "match_id":"qm-42","period_seq":1,"device_id":"openfc-494274"}
<<< {"evt":"state","enable":true,"mode":"auto","state":"ENABLED_AUTO",
     "timed":true,"duration_ms":15000,"remaining_ms":15000,
     "match_id":"qm-42","period_seq":1,"bound":true,"uptime_ms":41230}
<<< {"evt":"ack","cmd":"start_period"}

    ... the host page reloads mid-period. The board keeps counting. ...

>>> {"cmd":"get_timer"}
<<< {"evt":"timer_state","active":true,"mode":"auto","duration_ms":15000,
     "remaining_ms":6120,"elapsed_ms":8880,"match_id":"qm-42",
     "period_seq":1,"bound":true}

    Same token, so this re-establishes context instead of restarting:
>>> {"cmd":"start_period","mode":"auto","duration_ms":15000,
     "match_id":"qm-42","period_seq":1,"device_id":"openfc-494274"}
<<< {"evt":"ack","cmd":"start_period"}

    The server's clock says 6.4 s, the board says 6.1 s:
>>> {"cmd":"resync","match_id":"qm-42","period_seq":1,
     "remaining_ms":6400,"device_id":"openfc-494274"}
<<< {"evt":"ack","cmd":"resync","delta_ms":300}

<<< {"evt":"timer_expired","mode":"auto","duration_ms":15300,
     "elapsed_ms":15300,"reason":"timer","match_id":"qm-42","period_seq":1}
<<< {"evt":"estop","source":"timer","uptime_ms":56230}
<<< {"evt":"state","enable":false,"mode":"driver","state":"DISABLED",...}

    A new period needs a new period_seq; replaying seq 1 is refused:
>>> {"cmd":"start_period","mode":"driver","duration_ms":105000,
     "match_id":"qm-42","period_seq":2,"device_id":"openfc-494274"}
    ... driver control runs, then a referee stops the match early ...

>>> {"cmd":"end_period","match_id":"qm-42","period_seq":2,
     "device_id":"openfc-494274"}
<<< {"evt":"ack","cmd":"end_period"}
<<< {"evt":"timer_expired","mode":"driver","duration_ms":105000,
     "elapsed_ms":31400,"reason":"ended","match_id":"qm-42","period_seq":2}`}</Code>
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
