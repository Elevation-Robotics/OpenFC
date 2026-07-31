import { describe, it, expect } from 'vitest';
import { cmd, parseEvent } from '@/lib/openfc-protocol';

describe('command builders', () => {
  it('builds simple commands', () => {
    expect(JSON.parse(cmd.ping())).toEqual({ cmd: 'ping' });
    expect(JSON.parse(cmd.getState())).toEqual({ cmd: 'get_state' });
    expect(JSON.parse(cmd.getTimer())).toEqual({ cmd: 'get_timer' });
    expect(JSON.parse(cmd.getInfo())).toEqual({ cmd: 'get_info' });
    expect(JSON.parse(cmd.identify())).toEqual({ cmd: 'identify' });
    expect(JSON.parse(cmd.estop())).toEqual({ cmd: 'estop' });
  });

  it('builds set with enable + mode', () => {
    expect(JSON.parse(cmd.set(true, 'driver'))).toEqual({
      cmd: 'set',
      enable: true,
      mode: 'driver',
    });
  });

  it('builds start_period with duration_ms', () => {
    expect(JSON.parse(cmd.startPeriod('auto', 15000))).toEqual({
      cmd: 'start_period',
      mode: 'auto',
      duration_ms: 15000,
    });
  });

  it('does not append a newline (the serial layer does)', () => {
    expect(cmd.ping().includes('\n')).toBe(false);
  });
});

describe('period tokens (proto 3)', () => {
  const addr = { matchId: 'qm-42', periodSeq: 1, deviceId: 'openfc-494274' };

  it('builds start_period with a token and device binding', () => {
    expect(JSON.parse(cmd.startPeriod('auto', 15000, addr))).toEqual({
      cmd: 'start_period',
      mode: 'auto',
      duration_ms: 15000,
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
    });
  });

  it('omits device_id when the caller did not bind to a board', () => {
    const sent = JSON.parse(
      cmd.startPeriod('driver', 105000, { matchId: 'qm-42', periodSeq: 2 }),
    );
    expect(sent).toMatchObject({ match_id: 'qm-42', period_seq: 2 });
    expect('device_id' in sent).toBe(false);
  });

  it('builds resync and end_period', () => {
    expect(JSON.parse(cmd.resync(addr, 6400))).toEqual({
      cmd: 'resync',
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
      remaining_ms: 6400,
    });
    expect(JSON.parse(cmd.endPeriod(addr))).toEqual({
      cmd: 'end_period',
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
    });
  });

  it('keeps the untokenised start_period byte-identical to proto 2', () => {
    // Legacy hosts and older boards must see exactly the old command.
    expect(cmd.startPeriod('auto', 15000)).toBe(
      cmd.startPeriod('auto', 15000, undefined),
    );
    expect('match_id' in JSON.parse(cmd.startPeriod('auto', 15000))).toBe(false);
  });
});

describe('parseEvent', () => {
  it('parses a valid event', () => {
    const evt = parseEvent('{"evt":"heartbeat","uptime_ms":42}');
    expect(evt).toEqual({ evt: 'heartbeat', uptime_ms: 42 });
  });

  it('parses a hello with fw_hash', () => {
    const evt = parseEvent(
      '{"evt":"hello","fw_version":"1.2.0","hw_version":"1.1","device_id":"openfc-A1","fw_hash":"abc"}',
    );
    expect(evt).toMatchObject({ evt: 'hello', fw_hash: 'abc' });
  });

  it('parses a hello with a proto revision', () => {
    const evt = parseEvent(
      '{"evt":"hello","proto":2,"fw_version":"1.3.0","hw_version":"1.1","device_id":"openfc-A1","fw_hash":"abc"}',
    );
    expect(evt).toMatchObject({ evt: 'hello', proto: 2 });
  });

  it('parses a state carrying the diag flag', () => {
    const evt = parseEvent(
      '{"evt":"state","enable":false,"mode":"driver","state":"DISABLED","diag":true,"uptime_ms":10}',
    );
    expect(evt).toMatchObject({ evt: 'state', diag: true });
  });

  it('parses the token echoed in state and timer_state', () => {
    // The reconciliation path: one round trip must tell a reconnecting host
    // which period the board thinks it is running.
    expect(
      parseEvent(
        '{"evt":"state","enable":true,"mode":"auto","state":"ENABLED_AUTO",' +
          '"timed":true,"duration_ms":15000,"remaining_ms":6120,' +
          '"match_id":"qm-42","period_seq":1,"bound":true,"uptime_ms":41230}',
      ),
    ).toMatchObject({ match_id: 'qm-42', period_seq: 1, bound: true });

    expect(
      parseEvent(
        '{"evt":"timer_state","active":true,"mode":"auto","duration_ms":15000,' +
          '"remaining_ms":6120,"elapsed_ms":8880,"match_id":"qm-42",' +
          '"period_seq":1,"bound":true}',
      ),
    ).toMatchObject({ active: true, match_id: 'qm-42', period_seq: 1 });
  });

  it('parses the retired token reported when no period is running', () => {
    const evt = parseEvent(
      '{"evt":"timer_state","active":false,"last_match_id":"qm-42","last_period_seq":1}',
    );
    expect(evt).toMatchObject({
      active: false,
      last_match_id: 'qm-42',
      last_period_seq: 1,
    });
  });

  it('distinguishes an operator abort from a normal expiry', () => {
    expect(
      parseEvent(
        '{"evt":"timer_expired","mode":"driver","duration_ms":105000,' +
          '"elapsed_ms":31400,"reason":"ended","match_id":"qm-42","period_seq":2}',
      ),
    ).toMatchObject({ reason: 'ended' });
    expect(
      parseEvent(
        '{"evt":"timer_expired","mode":"auto","duration_ms":15000,' +
          '"elapsed_ms":15000,"reason":"timer"}',
      ),
    ).toMatchObject({ reason: 'timer' });
  });

  it('parses the resync ack drift measurement', () => {
    expect(parseEvent('{"evt":"ack","cmd":"resync","delta_ms":-300}')).toEqual({
      evt: 'ack',
      cmd: 'resync',
      delta_ms: -300,
    });
  });

  it('parses the proto-3 rejection reasons', () => {
    for (const reason of [
      'wrong_device',
      'token_mismatch',
      'period_complete',
      'invalid_token',
      'resync_out_of_range',
    ]) {
      expect(
        parseEvent(`{"evt":"error","reason":"${reason}","cmd":"start_period"}`),
      ).toMatchObject({ evt: 'error', reason });
    }
  });

  it('returns null for blank or whitespace lines', () => {
    expect(parseEvent('')).toBeNull();
    expect(parseEvent('   ')).toBeNull();
  });

  it('returns null for non-JSON noise', () => {
    expect(parseEvent('boot: rst:0x1 (POWERON)')).toBeNull();
  });

  it('returns null for JSON without an evt field', () => {
    expect(parseEvent('{"cmd":"ping"}')).toBeNull();
    expect(parseEvent('[1,2,3]')).toBeNull();
  });
});
