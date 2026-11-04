import { describe, expect, it } from 'vitest';
import type { ControlChannel, Signaler } from '../../../contracts/ports';
import type { Signal } from '../../../contracts/signaling';
import { SignalRouter } from './signal-router';

const OFFER: Signal = { t: 'sdp', d: { type: 'offer', sdp: 'v=0' } };

function setup({ healthy, ctrlOpen = true, serverUp = true }: { healthy: boolean; ctrlOpen?: boolean; serverUp?: boolean }) {
  const viaCtrl: unknown[] = [];
  const viaServer: Signal[] = [];
  // `ctrl` after a network switch: still "open", and `send` still succeeds into a dead association.
  const control = { isOpen: ctrlOpen, send: (m: unknown) => viaCtrl.push(m) > 0, on: () => () => undefined } as unknown as ControlChannel;
  const signaler: Signaler = { isConnected: serverUp, send: (s) => viaServer.push(s) > 0, onSignal: () => () => undefined, onPeerPresence: () => () => undefined };
  return { viaCtrl, viaServer, control, signaler, router: new SignalRouter(control, signaler, () => healthy) };
}

describe('SignalRouter', () => {
  it('uses the direct ctrl channel while the connection is healthy', () => {
    const { router, viaCtrl, viaServer } = setup({ healthy: true });
    expect(router.send(OFFER)).toBe(true);
    expect(viaCtrl).toEqual([OFFER]);
    expect(viaServer).toEqual([]);
  });

  it('sends an ICE restart through the server while recovering, even though ctrl still reads open', () => {
    const { router, viaCtrl, viaServer } = setup({ healthy: false });
    expect(router.send(OFFER)).toBe(true);
    expect(viaServer).toEqual([OFFER]);
    expect(viaCtrl).toEqual([]);
  });

  it('falls back to ctrl while recovering if the server is not reachable yet', () => {
    const { router, viaCtrl } = setup({ healthy: false, serverUp: false });
    expect(router.send(OFFER)).toBe(true);
    expect(viaCtrl).toEqual([OFFER]);
  });

  it('falls back to the server when ctrl is closed, and reports failure when neither path is up', () => {
    expect(setup({ healthy: true, ctrlOpen: false }).router.send(OFFER)).toBe(true);
    expect(setup({ healthy: false, ctrlOpen: false, serverUp: false }).router.send(OFFER)).toBe(false);
  });

  it('link mode (no server) always uses ctrl', () => {
    const { control } = setup({ healthy: false });
    const sent: unknown[] = [];
    const router = new SignalRouter({ ...control, isOpen: true, send: (m) => sent.push(m) > 0 }, null, () => false);
    expect(router.send(OFFER)).toBe(true);
    expect(sent).toEqual([OFFER]);
  });
});
