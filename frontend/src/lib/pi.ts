/** The Raspberry Pi's address on the Greenova Wi-Fi. Every "open on your phone" QR code points
 * here (the website's Open on phone button and the QR that `npm run dev` prints). Change it here
 * if the Pi gets another address (or set GREENOVA_PI_ADDRESS before `npm run dev`). */
export const PI_ADDRESS = "192.168.254.129";

/** The website on the Pi, on the given port ("" = the browser's default port). */
export function piUrl(port: string, path = ""): string {
  return `http://${PI_ADDRESS}${port ? `:${port}` : ""}${path}`;
}
