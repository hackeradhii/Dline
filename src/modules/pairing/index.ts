/** Public API of the pairing module: rendezvous rooms and the serverless link fallback. */
export { RendezvousSignaler } from './internal/rendezvous-signaler';
export { HostLinkPairing, createReply, peekSession, linkUrl } from './internal/link-pairing';
export { parseFragment, linkErrorReason, type LinkErrorReason } from './internal/link-codec';
export { listenForReplies, deliverReply } from './internal/handoff';
