/** Public API of the pairing module: rendezvous rooms and the serverless link fallback. */
export { RendezvousSignaler, type RendezvousEvents, type RendezvousOptions, type SocketState } from './internal/rendezvous-signaler';
export { HostLinkPairing, createReply, peekSession, linkUrl } from './internal/link-pairing';
export { parseFragment, LinkError, linkErrorReason, type Fragment, type LinkErrorReason, type LinkKind } from './internal/link-codec';
export { listenForReplies, deliverReply } from './internal/handoff';
