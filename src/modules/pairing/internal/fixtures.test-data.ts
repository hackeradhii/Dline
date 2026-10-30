/** Realistic data-channel-only SDPs captured in the shape Chrome and Firefox produce. */

const FP = '6F:4E:2A:91:0C:7D:3B:88:12:AB:CD:EF:01:23:45:67:89:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB';

export const CHROME_OFFER = [
  'v=0',
  'o=- 6264429402375397476 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:2999745851 1 udp 2122260223 4d6b7f3e-12ab-4cde-9f01-23456789abcd.local 56123 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:842163049 1 udp 1686052607 203.0.113.7 56123 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-id 1 network-cost 10',
  'a=candidate:1111111111 1 udp 1686052863 2401:4900:1c2a:5d6e::1f 50001 typ srflx raddr :: rport 0 generation 0 network-id 2 network-cost 900',
  'a=candidate:4233069003 1 tcp 1518280447 4d6b7f3e-12ab-4cde-9f01-23456789abcd.local 9 typ host tcptype active generation 0',
  'a=ice-ufrag:Xk3f',
  'a=ice-pwd:9yHq2pZQ1rWnVx3mKdLs8TbE',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

export const FIREFOX_ANSWER = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 7271343386925232110 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  `a=fingerprint:sha-256 ${FP}`,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 192.168.1.20 54321 typ host',
  'a=candidate:1 1 UDP 1686052863 198.51.100.9 54321 typ srflx raddr 192.168.1.20 rport 54321',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:3c5a1f2e8b9d4c6a7e0f1b2c3d4e5f6a',
  'a=ice-ufrag:a1b2c3d4',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

export const AUDIO_VIDEO_OFFER = CHROME_OFFER.replace('m=application', 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application');
