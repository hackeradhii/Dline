import type { ManualExchange } from '../../connection';
import { decodeLink, encodeLink, LinkError, newSessionId, type LinkKind } from './link-codec';

/** Builds a shareable URL for a link fragment. */
export function linkUrl(baseUrl: string, fragment: string): string {
  const url = new URL(baseUrl);
  url.hash = fragment;
  return url.toString();
}

/**
 * Host side of the serverless two-link exchange. Each invite pairs once, and only with a reply that
 * carries its session ID.
 */
export class HostLinkPairing {
  readonly session = newSessionId();
  #applied = false;

  constructor(
    private readonly exchange: ManualExchange,
    private readonly baseUrl: string,
  ) {}

  async createInvite(): Promise<string> {
    const offer = await this.exchange.createOffer();
    return linkUrl(this.baseUrl, await encodeLink({ kind: 'o', session: this.session, description: offer }));
  }

  /** Applies a reply (`a.` fragment body). Throws LinkError with a reason the UI can explain. */
  async applyReply(text: string): Promise<void> {
    if (this.#applied) throw new LinkError('used');
    const reply = await decodeLink('a', text);
    if (reply.session !== this.session) throw new LinkError('session');
    this.#applied = true;
    await this.exchange.acceptAnswer(reply.description);
  }
}

/** Guest side: turns an invite into a reply link. */
export async function createReply(exchange: ManualExchange, inviteText: string, baseUrl: string): Promise<{ url: string; session: string }> {
  const invite = await decodeLink('o', inviteText);
  const answer = await exchange.acceptOffer(invite.description);
  const fragment = await encodeLink({ kind: 'a', session: invite.session, description: answer });
  return { url: linkUrl(baseUrl, fragment), session: invite.session };
}

/** Reads the session ID of a link body without applying it (used by the same-browser handoff). */
export async function peekSession(kind: LinkKind, text: string): Promise<string> {
  return (await decodeLink(kind, text)).session;
}
