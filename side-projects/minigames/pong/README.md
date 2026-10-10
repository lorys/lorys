# Pong over WebRTC

Two-player Pong where each player uses their own phone. The phones connect
directly to each other over WebRTC, with no game server. You pair them by
scanning two QR codes.

## Requirements

- Two Android phones with Chrome, on the **same Wi-Fi** (or one phone's hotspot).
- The page must be served over **HTTPS**, because the camera only works on
  secure pages.

## Hosting

Any static host works, for example GitHub Pages: publish the `pong/` folder.

To run it locally over HTTPS on your LAN:

```bash
cd pong
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=pong"
npx http-server . -S -C cert.pem -K key.pem -p 8443
```

Open `https://<your-computer-ip>:8443` on both phones. Accept the certificate
warning (Advanced → Proceed).

## Playing

1. Phone A: **Create game**. A QR code appears.
2. Phone B: **Join game** and scan phone A's code. Phone B then shows its own code.
3. Phone A: **Scan reply** and scan phone B's code. The game starts.

Drag your finger to move your paddle (it's always at the bottom of your
screen). The first player to 7 points wins.

## Testing on a desktop

Run `npx http-server .` and open `http://localhost:8080` in **two separate
Chrome windows placed side by side**. Hidden tabs pause the game and end the
match. Use the code text boxes and *Copy* / *Use pasted code* instead of
scanning.
