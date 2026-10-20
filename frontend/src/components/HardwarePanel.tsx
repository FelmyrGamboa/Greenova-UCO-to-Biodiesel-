import { useEffect, useState } from "react";
import { Button, Card, Field, Heading, Status } from "./ui";
import { calibrateLoadCell, getHardware, isOffline, tareLoadCell, type HardwareInfo, type LoadCellInfo } from "../lib/api";
import { useLanguage } from "../lib/i18n";

/**
 * Settings -> Hardware: the ESP32 controller (online, port, which output does which job), the
 * centrifuge on the Pi, and the load cells with Tare / Calibrate. Read from GET /api/hardware.
 */
export default function HardwarePanel({ backend }: { backend: boolean }) {
  const { t } = useLanguage();
  const [info, setInfo] = useState<HardwareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!backend) {
      setInfo(null);
      return;
    }
    let stopped = false;
    const load = () =>
      getHardware()
        .then((next) => { if (!stopped) { setInfo(next); setError(null); } })
        .catch((e) => { if (!stopped) setError(isOffline(e) ? null : e instanceof Error ? e.message : String(e)); });
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [backend]);

  const controller = info?.controller ?? null;
  const online = Boolean(controller?.online) && !info?.fault;

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Heading as="h2" className="text-lg font-semibold">{t("Hardware")}</Heading>
          <p className="mt-1 text-sm text-gray-500">{t("ESP32 output controller, centrifuge and load cells on the Raspberry Pi.")}</p>
        </div>
        {!backend || !info ? (
          <Status tone="neutral">{t("Backend offline")}</Status>
        ) : info.backend === "demo" ? (
          <Status tone="yellow">{t("Demo mode · simulated machine")}</Status>
        ) : info.backend === "esp32" ? (
          <Status tone={online ? "green" : "red"}>{online ? t("ESP32 online") : controller?.online ? t("ESP32 fault") : t("ESP32 offline")}</Status>
        ) : (
          <Status tone="blue">{t("Pi GPIO outputs")}</Status>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-red-400">{t(error)}</p>}

      {info?.backend === "demo" && (
        <p className="mt-4 text-sm leading-6 text-gray-400">
          {t("The backend is in demo mode, so the machine is simulated and nothing is switched. On the Raspberry Pi, run setup-pi.sh --hardware to drive the real ESP32 controller, centrifuge and load cell.")}
        </p>
      )}

      {info?.backend === "esp32" && controller && (
        <div className="mt-6 space-y-6">
          {info.fault && (
            <div className="rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm text-red-300">{t(info.fault)}</div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Fact label={t("USB port")} value={controller.port ?? "—"} />
            <Fact label={t("Temperature (ESP32 probe)")} value={controller.temperature == null ? "—" : `${controller.temperature.toFixed(1)} °C`} />
            <Fact label={t("Dead-man timer")} value={controller.leaseSeconds ? t("outputs stop {seconds} s after the Pi does", { seconds: controller.leaseSeconds }) : t("off")} />
          </div>

          <div>
            <div className="gv-label">{t("Which ESP32 output does each job")}</div>
            <div className="mt-2 overflow-x-auto rounded-xl border border-white/[0.07]">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="bg-gv-inset text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">{t("Job")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("ESP32 output")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Greenova")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("ESP32 reports")}</th>
                  </tr>
                </thead>
                <tbody>
                  {info.roles.map((role) => {
                    const reported = role.controllerOn.filter((value) => value !== null);
                    const mismatch = reported.some((value) => value !== role.on) && !role.maxOnSeconds;
                    return (
                      <tr key={role.role} className="border-t border-white/[0.06]">
                        <td className="px-4 py-2.5 text-gray-300">{t(role.label)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-gray-400">
                          {role.devices.length ? role.devices.join(" + ") : t("not fitted")}
                          {role.maxOnSeconds ? ` · ${t("max {seconds} s", { seconds: role.maxOnSeconds })}` : ""}
                        </td>
                        <td className="px-4 py-2.5">
                          <Status tone={role.on ? "green" : "neutral"}>{role.on ? (role.rpm ? `${t("On")} · ${role.rpm} RPM` : t("On")) : t("Off")}</Status>
                        </td>
                        <td className="px-4 py-2.5">
                          {reported.length === 0 ? (
                            <span className="text-xs text-gray-600">—</span>
                          ) : (
                            <Status tone={mismatch ? "yellow" : reported.some(Boolean) ? "green" : "neutral"}>
                              {reported.some(Boolean) ? t("On") : t("Off")}
                            </Status>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs leading-5 text-gray-600">
              {t("Set in backend/hardware.toml under [esp32.devices]. Check each one with python -m app.hwtest outputs before the first batch.")}
              {controller.devices.some((device) => !device.used) &&
                ` ${t("Not used by Greenova (switched off by the emergency stop): {devices}.", { devices: controller.devices.filter((device) => !device.used).map((device) => device.id).join(", ") })}`}
            </p>
          </div>

          {info.centrifuge && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Fact label={t("Centrifuge (Pi, BTS7960)")} value={`${info.centrifuge.rpm.toLocaleString()} / ${info.centrifuge.maxRpm.toLocaleString()} RPM`} />
              <Fact label={t("Target")} value={`${info.centrifuge.targetRpm.toLocaleString()} RPM · ${info.centrifuge.duty}% PWM`} />
              <Fact label={t("RPM")} value={info.centrifuge.error ? t(info.centrifuge.error) : t("worked out from the PWM (no speed sensor)")} />
            </div>
          )}

          {controller.messages.length > 0 && (
            <details className="rounded-xl border border-white/[0.07] bg-gv-inset p-4">
              <summary className="cursor-pointer text-sm text-gray-400">{t("ESP32 messages")}</summary>
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5 text-gray-500">{controller.messages.join("\n")}</pre>
            </details>
          )}
        </div>
      )}

      {info && info.backend !== "demo" && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {info.loadCells.map((cell) => (
            <LoadCellCard key={cell.key} cell={cell} canCalibrate={info.backend === "esp32"} onChange={(cells) => setInfo({ ...info, loadCells: cells })} />
          ))}
        </div>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-4">
      <div className="gv-label">{label}</div>
      <div className="mt-1 break-words text-sm text-gray-300">{value}</div>
    </div>
  );
}

function LoadCellCard({ cell, canCalibrate, onChange }: { cell: LoadCellInfo; canCalibrate: boolean; onChange: (cells: LoadCellInfo[]) => void }) {
  const { t } = useLanguage();
  const [grams, setGrams] = useState("");
  const [busy, setBusy] = useState<"tare" | "calibrate" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(step: "tare" | "calibrate") {
    setMessage(null);
    const known = Number(grams);
    if (step === "calibrate" && !(known > 0)) {
      setMessage({ ok: false, text: t("Enter the known weight in grams (more than 0).") });
      return;
    }
    setBusy(step);
    try {
      if (step === "tare") {
        const done = await tareLoadCell(cell.key);
        onChange(done.loadCells);
        setMessage({ ok: true, text: t("Zeroed.") });
      } else {
        const done = await calibrateLoadCell(cell.key, known);
        onChange(done.loadCells);
        setMessage({ ok: true, text: t("Calibrated: {scale} counts per gram (noise about {noise} g).", { scale: done.result.scale.toFixed(3), noise: done.result.resolutionG }) });
      }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? t(e.message) : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-gray-300">{t(cell.label)}</div>
        {!cell.enabled ? (
          <Status tone="neutral">{t("Not fitted")}</Status>
        ) : (
          <Status tone={cell.grams == null ? "red" : "green"}>{cell.grams == null ? t("No reading") : `${cell.grams.toFixed(1)} g`}</Status>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-600">
        HX711 · DT GPIO{cell.dataPin} · SCK GPIO{cell.clockPin}
        {cell.enabled && cell.scale !== undefined && ` · ${t("scale {scale}, offset {offset}", { scale: cell.scale, offset: cell.offset ?? 0 })}`}
        {cell.calibratedAt && ` · ${t("calibrated {date}", { date: cell.calibratedAt.replace("T", " ") })}`}
      </p>
      {!cell.enabled ? (
        <p className="mt-3 text-xs leading-5 text-gray-500">{t("Enable it in backend/hardware.toml ([load_cells.{key}] enabled = true) when it is wired.", { key: cell.key })}</p>
      ) : canCalibrate ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Button variant="secondary" disabled={busy !== null} onClick={() => run("tare")}>{busy === "tare" ? t("Zeroing… (3 s)") : t("Tare (empty)")}</Button>
            <div className="w-36"><Field label={t("Known weight")} inputMode="decimal" value={grams} onChange={(event) => setGrams(event.target.value.replace(/[^\d.]/g, ""))} unit="g" /></div>
            <Button variant="secondary" disabled={busy !== null} onClick={() => run("calibrate")}>{busy === "calibrate" ? t("Calibrating… (3 s)") : t("Calibrate")}</Button>
          </div>
          <p className="text-xs leading-5 text-gray-600">{t("1. Empty it (or only the empty container) and press Tare. 2. Put a known weight on it, type its grams and press Calibrate. Only while no process is running.")}</p>
        </div>
      ) : (
        <p className="mt-3 text-xs leading-5 text-gray-500">{t("Calibrate with: python -m app.hwtest calibrate {key}", { key: cell.key })}</p>
      )}
      {message && <p className={`mt-3 text-sm ${message.ok ? "text-green-400" : "text-red-400"}`}>{message.text}</p>}
    </div>
  );
}
