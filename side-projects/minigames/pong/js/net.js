// WebRTC peer connection with manual (QR / copy-paste) signaling.

const RTC_CONFIG = { iceServers: [] }; // same LAN only, no STUN/TURN
const CHANNEL_OPTIONS = { ordered: false, maxRetransmits: 0 };
const ICE_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;
const NO_CONNECT = "Couldn't connect. Make sure both phones are on the same Wi-Fi and try again.";

export async function host() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('pong', CHANNEL_OPTIONS);
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  return {
    offer: await pack(pc.localDescription),
    async accept(answer) {
      await pc.setRemoteDescription(answer);
      return connection(pc, channel, CONNECT_TIMEOUT_MS);
    },
  };
}

export async function join(offer) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = new Promise((resolve) => (pc.ondatachannel = (e) => resolve(e.channel)));
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await iceGathered(pc);
  return {
    answer: await pack(pc.localDescription),
    connected: channel.then((ch) => connection(pc, ch, 0)),
  };
}

// Non-trickle ICE: the packed description must already contain every candidate.
function iceGathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ICE_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// Resolves once the channel opens; rejects if it fails first or the timeout (if any) hits.
function connection(pc, channel, timeoutMs) {
  return new Promise((resolve, reject) => {
    let open = false;
    let closed = false;
    const conn = {
      onmessage: null,
      onclose: null,
      send(msg) {
        if (channel.readyState === 'open') channel.send(JSON.stringify(msg));
      },
      close() {
        pc.close();
      },
    };
    const lost = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (open) {
        conn.onclose?.();
      } else {
        pc.close();
        reject(new Error(NO_CONNECT));
      }
    };
    const timer = timeoutMs ? setTimeout(lost, timeoutMs) : 0;
    const opened = () => {
      if (open || closed) return;
      open = true;
      clearTimeout(timer);
      resolve(conn);
    };
    channel.onopen = opened;
    channel.onclose = lost;
    channel.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      conn.onmessage?.(msg);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) lost();
    };
    if (channel.readyState === 'open') opened();
  });
}

export async function pack(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  const bytes = await transform(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function unpack(code) {
  const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(await transform(bytes, new DecompressionStream('deflate-raw')));
  const desc = JSON.parse(json);
  if ((desc.type !== 'offer' && desc.type !== 'answer') || typeof desc.sdp !== 'string') {
    throw new Error('Not a Pong code');
  }
  return desc;
}

async function transform(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
