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
