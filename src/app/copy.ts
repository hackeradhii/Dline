/** All user-facing explanations in one place, so wording stays consistent (DRY). */
import type { ServerErrorCode } from '../contracts/signaling';
import type { FailureReason } from '../modules/connection';
import type { NoPathCause, Verdict } from '../modules/diagnostics';
import type { LinkErrorReason } from '../modules/pairing';
import type { CallNotice } from '../modules/call';
import type { PacingMode, TransferError } from '../modules/transfer';
import { formatSpeed } from '../shared/format';

export const VERDICT_COPY: Record<Verdict, { title: string; detail: string }> = {
  good: { title: 'Ready for a direct connection', detail: 'Your network allows peer-to-peer connections.' },
  risky: {
    title: 'Direct connection may be hard',
    detail: 'Your network uses strict address sharing. It usually still works if the other person is on mobile data.',
  },
  blocked: {
    title: 'This network blocks direct connections',
    detail: 'UDP traffic is blocked here (common on office, college and hotel Wi-Fi). Switch to mobile data if you can.',
  },
};

export const FAILURE_TITLE: Record<FailureReason, string> = {
  'no-path': 'No direct path between these two networks',
  lost: 'Connection lost',
  'peer-left': 'They left',
};

export const FAILURE_DETAIL: Record<FailureReason, string> = {
  'no-path': 'The two devices could not reach each other directly.',
  lost: 'The connection dropped and could not recover. This usually means one device changed or lost its network.',
  'peer-left': 'The other person closed Dline or ended the session.',
};

export const CAUSE_COPY: Record<NoPathCause, string> = {
  'local-blocked': 'Your network blocks UDP, which direct connections need.',
  'remote-blocked': 'Their network blocks UDP, which direct connections need.',
  'both-strict-nat': 'Both of you are behind strict (symmetric) NAT, so hole punching cannot work.',
  'family-mismatch': 'One of you only has IPv4 and the other only IPv6, so there is no common route.',
  'relay-only-browser': 'A browser setting or extension is forcing traffic through a relay.',
  unknown: 'A firewall between the two networks is probably filtering the traffic.',
};

export const NO_PATH_ADVICE = [
  'Switch one phone from Wi-Fi to mobile data (it often has IPv6) and try again.',
  'Try a different Wi-Fi network.',
  'Or turn on the relay in Settings. It works everywhere, but it is not peer-to-peer.',
] as const;

export const LINK_ERROR_COPY: Record<LinkErrorReason, string> = {
  malformed: 'That link is incomplete or damaged. Copy the whole link and try again.',
  version: 'That link was made by a different version of Dline. Ask them to create a new one.',
  kind: 'That is an invite, not a reply. Paste the reply link they sent back.',
  session: 'That reply belongs to a different invite. Use the reply to the invite shown on this screen.',
  used: 'This invite is already connected. Create a new invite to connect again.',
};

export const SERVER_ERROR_COPY: Record<ServerErrorCode, string> = {
  'room-full': 'That code is already in use by two people.',
  'no-room': 'No line with that code. Check the code, or ask them to start a new one.',
  'bad-request': 'Something went wrong while pairing. Try again.',
  'rate-limited': 'Too many attempts. Wait a moment and try again.',
  expired: 'That code has expired. Ask them to start a new line.',
  replaced: 'You opened this line in another tab.',
};

export const CALL_NOTICE_COPY: Record<CallNotice, string> = {
  declined: 'They declined the call.',
  ended: 'Call ended.',
  busy: 'They are busy.',
  denied: 'Camera and microphone are blocked. Allow them in the browser settings to call.',
  unavailable: 'No camera or microphone was found.',
};

export const TRANSFER_ERROR_COPY: Record<TransferError, string> = {
  unreadable: 'Could not read the file.',
  'arrived-damaged': 'The file arrived damaged. Try sending it again.',
  'no-response': 'No response from the other device.',
  'bad-block': 'Received a block that does not fit the file.',
  damaged: 'File damaged in transit. Ask them to send it again.',
  unsaved: 'Could not save the file.',
};

/** The performance-stats switch in Settings: what is sent, and what never is. */
export const SHARE_METRICS_COPY = {
  label: 'Share performance stats',
  detail:
    "Sends numbers only to the Dline server's log: file sizes, speeds, timings, the connection type and your browser. Never file names, file contents, messages or your camera. Applies to the next connection.",
} as const;

export const IN_APP_BROWSER_COPY = 'This app browser may block the camera. Tap ⋯ and choose "Open in browser" (Chrome or Safari).';

/** "File pacing" in the connection details: the upload budget files get right now. */
export function filePacingCopy(limit: number | null, callActive: boolean): string {
  if (limit === null) return 'Off';
  if (limit === 0) return 'Paused for a moment to measure the line';
  return callActive ? `${formatSpeed(limit)}, leaving room for the call` : formatSpeed(limit);
}

/** The pacing mode, shown with `?debug=1`. */
export const PACING_MODE_COPY: Record<PacingMode, string> = {
  legacy: 'Legacy (before Flow)',
  shadow: 'Shadow (Flow measures, legacy paces)',
  flow: 'Flow',
};
