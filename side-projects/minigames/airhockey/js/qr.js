// QR rendering (vendored qrcode-generator, global `qrcode`) and native scanning.

const SCAN_INTERVAL_MS = 100;

export const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

export function renderQR(container, text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

export async function startScan(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || video.readyState < 2) return;
    busy = true;
    const codes = await detector.detect(video).catch(() => []);
    busy = false;
    if (codes.length) onCode(codes[0].rawValue);
  }, SCAN_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

// With camera permission granted, Chrome puts real LAN IPs in ICE candidates
// instead of mDNS .local names, which some Android networks fail to resolve.
export async function primeCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied: pairing still works via mDNS or copy/paste.
  }
}
