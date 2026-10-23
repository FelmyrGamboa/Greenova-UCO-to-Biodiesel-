import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { piUrl, PI_ADDRESS } from "../lib/pi";
import { qrModules, qrSvgPath } from "../lib/qr";
import { useT } from "../lib/i18n";

/** The address a phone opens: always the Raspberry Pi (PI_ADDRESS), on this page's port
 * (8443 for the website in Docker, 8000 when the backend serves it). */
function phoneUrl(): string {
  return piUrl(window.location.port, "/dashboard");
}

function QrImage({ text }: { text: string }) {
  const t = useT();
  const { size, d } = useMemo(() => qrSvgPath(qrModules(text)), [text]);
  return (
    // Always dark on white, in both themes, so every phone camera can read it.
    <svg viewBox={`0 0 ${size} ${size}`} className="h-56 w-56 rounded-xl" shapeRendering="crispEdges" role="img" aria-label={t("QR code for {url}", { url: text })}>
      <rect width={size} height={size} fill="#ffffff" />
      <path d={d} fill="#0b120e" />
    </svg>
  );
}

const PhoneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
    <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </svg>
);

/** "Open on phone": a button that shows a QR code of the website on the Raspberry Pi. */
export default function PhoneAccess({ className = "" }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = phoneUrl();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not allowed: the address is on screen to type
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex w-full items-center justify-center gap-2 rounded-lg border border-white/[0.08] px-3 py-2 text-xs font-medium text-gray-400 transition-colors hover:bg-white/[0.04] hover:text-white ${className}`}
      >
        <PhoneIcon />
        {t("Open on phone")}
      </button>

      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="phone-access-title"
              // className="glass fade-in-up w-full max-w-md rounded-2xl p-6"
              className="glass fade-in-up w-full max-w-md max-h-[90dvh] overflow-y-auto overscroll-contain rounded-2xl p-4 sm:p-6"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 id="phone-access-title" className="font-display text-lg font-semibold text-white">{t("Open on your phone")}</h2>
                  <p className="mt-1 text-sm text-gray-500">{t("Scan with the phone's camera to open Greenova on the Raspberry Pi.")}</p>
                </div>
                <button type="button" onClick={() => setOpen(false)} aria-label={t("Close")} className="rounded-md px-2 py-1 text-lg leading-none text-gray-500 hover:text-white">×</button>
              </div>

              <div className="mt-6 flex flex-col items-center">
                <QrImage text={url} />
                <div className="mt-4 flex w-full items-center gap-2 rounded-lg border border-white/[0.08] bg-gv-inset px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-gray-200">{url}</span>
                  <button type="button" onClick={copy} className="shrink-0 text-xs font-semibold text-green-400 hover:text-green-300">{copied ? t("Copied") : t("Copy")}</button>
                </div>
              </div>

              <div className="mt-6 space-y-2 rounded-xl border border-white/[0.07] bg-gv-inset p-4 text-xs leading-5 text-gray-500">
                <p className="font-semibold text-gray-300">{t("It doesn't open on the phone?")}</p>
                <p>{t("The phone must be on the same Wi-Fi as the Raspberry Pi ({address}), and the Pi must be on.", { address: PI_ADDRESS })}</p>
                <p>{t("School and public Wi-Fi often block devices from reaching each other. Use the Wi-Fi the Pi is on.")}</p>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
