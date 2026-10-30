/** Small view-model helpers shared by several components (DRY). */
import type { ConnectionPhase } from '../modules/connection';
import { describePath, type PathInfo } from '../modules/diagnostics';
import type { LineState } from '../ui/Line.svelte';
import type { PlateTone } from '../ui/Plate.svelte';

export function lineState(phase: ConnectionPhase, path: PathInfo | null | undefined): LineState {
  if (phase === 'lost' || phase === 'closed') return 'cut';
  if (phase !== 'connected' && phase !== 'unstable') return 'connecting';
  if (path?.relayed) return 'relay';
  return phase === 'unstable' ? 'connecting' : 'direct';
}

/** The status lamp's colour for a line state: only a live line or a lost one gets a colour. */
export function plateTone(state: LineState): PlateTone {
  return state === 'direct' || state === 'relay' || state === 'cut' ? state : 'idle';
}

export function statusText(phase: ConnectionPhase, path: PathInfo | null | undefined): string {
  if (phase === 'unstable') return 'Unstable, trying to recover…';
  if (phase === 'lost' || phase === 'closed') return 'Disconnected';
  if (phase !== 'connected') return 'Connecting…';
  return path ? describePath(path) : 'Connected';
}

/** File types that can run code when opened: received ones get a warning. */
const RUNNABLE = /\.(apk|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jar|sh|dmg|pkg|app|deb|rpm|appimage|lnk|hta|reg)$/i;

export function isRunnableFile(name: string): boolean {
  return RUNNABLE.test(name);
}

/** "report.pdf" → "PDF", used on the card for files that can't be previewed. */
export function fileTypeLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : 'File';
}

/** Attachment that plays a MediaStream in a <video>. */
export function playStream(stream: MediaStream | null) {
  return (video: HTMLVideoElement) => {
    video.srcObject = stream;
    if (stream) void video.play().catch(() => undefined);
    return () => {
      video.srcObject = null;
    };
  };
}
