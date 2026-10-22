import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { batchTone, Button, Card, Dialog, Heading, Metric, Progress, Status } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { getSystemStatus, useActiveBatch, useBatches, type PurificationPhase, type SystemStatus } from "../lib/api";
import { useT } from "../lib/i18n";

const PUMP_LABELS = { catalyst: "Pump A · NaOH/KOH + methanol", acid: "Pump B · H₂SO₄ + methanol", oil: "Oil pump" } as const;
const PURIFICATION_STEP: Partial<Record<PurificationPhase, string>> = {
  heating: "Heating", methanol: "Methanol removal", magnesol: "Add adsorbent", contact: "Contact",
  settle: "Settling", drain: "Draining",
};

function deviceTone(status: string) {
  if (["Fault", "No reading"].includes(status)) return "red" as const;
  if (["On", "Running", "Open", "Pumping"].includes(status) || status.startsWith("Running")) return "yellow" as const;
  return "green" as const;
}

export default function Dashboard() {
  const t = useT();
  const navigate = useNavigate();
  const { batches, source } = useBatches();
  const { live, backend } = useLiveData();
  // The batch in progress (only one at a time): it is continued, never started again.
  const { active } = useActiveBatch();
  const [startBlocked, setStartBlocked] = useState(false);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const completed = batches.filter((batch) => batch.status === "Completed");
  const finished = batches.filter((batch) => batch.status !== "In Progress");
  const successRate = finished.length ? (completed.length / finished.length) * 100 : 0;
  const recent = batches.slice(0, 5);

  useEffect(() => {
    if (!backend) {
      setSystemStatus(null);
      return;
    }
    let stopped = false;
    const load = () => getSystemStatus().then((status) => { if (!stopped) setSystemStatus(status); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [backend]);

  const stage = live ? live.stage : null;
  const purification = live ? live.purification : null;
  const stageActive = stage !== null && stage.stage !== null && (stage.state === "running" || stage.state === "paused");
  const purifying = purification !== null && purification.phase in PURIFICATION_STEP;
  const pump = live && live.pump.phase === "pumping" ? live.pump : null;
  const liveBatchId = stageActive && stage ? stage.batchId : purifying && purification ? purification.batchId
    : pump ? pump.batchId : null;
  const settling = stageActive && stage?.stage === "Separation" && stage.phase === "settling";
  // What the machine is doing right now (null when it is idle)
  const liveStage = stageActive && stage && stage.stage
    ? `${t(stage.stage)} · ${settling ? t("settling") : t(stage.state)}`
    : purifying && purification
      ? `${t("Purification")} · ${t(PURIFICATION_STEP[purification.phase] ?? "")}`
      : pump && pump.pump
        ? `${t("Pumping")} · ${t(PUMP_LABELS[pump.pump])}`
        : null;
  // A batch is ongoing while it is In Progress, even between steps when the machine is idle.
  const ongoing = active !== null || liveStage !== null;
  const ongoingId = active?.id ?? liveBatchId;
  const stageText = liveStage ?? (active ? t(active.currentStage || "Volume & Parameters") : null);
  const sensors = live?.sensors;
  const devices = systemStatus?.devices ?? [];
  const readiness = systemStatus?.readiness ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">{t("Production overview")}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Dashboard")}</Heading>
          <p className="mt-2 text-sm text-gray-500">{t("A concise view of the current process, devices, and recent batch performance.")}</p>
        </div>
        {ongoing ? (
          // Only one batch at a time: starting another is refused, and the ongoing one is offered instead.
          <Button onClick={() => setStartBlocked(true)}>{t("Start New Process")} <span>→</span></Button>
        ) : (
          <Link to="/process" className="btn-primary">{t("Start New Process")} <span>→</span></Link>
        )}
      </div>

      {startBlocked && (
        <Dialog
          title={t("A batch is already in progress")}
          onClose={() => setStartBlocked(false)}
          actions={
            <>
              <Button variant="ghost" onClick={() => setStartBlocked(false)}>{t("Close")}</Button>
              <Button onClick={() => navigate("/process")}>{t("Continue Process")} →</Button>
            </>
          }
        >
          {t("Batch {id} is still being processed ({stage}). Only one batch can be processed at a time: continue it, or cancel it on the Process page, before starting a new one.", { id: ongoingId ?? t("A batch"), stage: stageText ?? "—" })}
        </Dialog>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5"><Metric label={t("Current Batch")} value={ongoingId || (ongoing ? t("Unassigned") : t("No active batch"))} sub={ongoing ? t("In progress") : t("System ready")} /></Card>
        <Card className="p-5"><Metric label={t("Current Stage")} value={stageText ?? "—"} sub={liveStage ? t("Live from the Raspberry Pi") : ongoing ? t("Waiting for the operator") : t("Start a new process")} /></Card>
        <Card className="p-5"><Metric label={t("Total Batches")} value={batches.length} sub={source === "offline" ? t("Raspberry Pi offline") : t("Raspberry Pi records")} accent /></Card>
        <Card className="p-5"><Metric label={t("Success Rate")} value={`${successRate.toFixed(1)}%`} sub={t("Completed batches")} accent /></Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-white/[0.06] p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Heading as="h2" className="text-lg font-semibold">{t("Current Process")}</Heading>
              <p className="mt-1 text-sm text-gray-500">
                {liveStage
                  ? t("{batch} is running.", { batch: ongoingId ?? t("A batch") })
                  : ongoing
                    ? t("{batch} is in progress.", { batch: ongoingId ?? t("A batch") })
                    : t("No production batch is currently running.")}
              </p>
            </div>
            {ongoing ? <Status tone="blue">{t("In progress")}</Status> : <Status>{t("System ready")}</Status>}
          </div>
          <div className="p-6">
            {ongoing && (liveStage === null || stage === null) ? (
              // In progress, between steps (the machine is idle): waiting for the operator to continue it.
              <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Metric label={t("Batch")} value={ongoingId ?? "—"} accent />
                  <Metric label={t("Stage")} value={stageText ?? "—"} />
                </div>
                <p className="mt-4 text-sm text-gray-500">{t("The batch is waiting for its next step. Continue it on the Process page: a new batch can't be started until this one is finished or cancelled.")}</p>
                <Link to="/process" className="btn-primary mt-5">{t("Continue Process")} →</Link>
              </div>
            ) : liveStage !== null && stage !== null ? (
              <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-6">
                {/* only the running stage's own live readings */}
                <div className="grid gap-5 sm:grid-cols-4">
                  <Metric label={t("Stage")} value={stageActive && stage.stage ? t(stage.stage) : purifying ? t("Purification") : t("Pumping")} />
                  {stageActive && stage.stage !== "Separation" && (
                    <>
                      <Metric label={t("Temperature")} value={sensors?.temperature == null ? "—" : `${sensors.temperature.toFixed(1)} °C`} />
                      <Metric label={t("Voltage")} value={sensors?.voltage == null ? "—" : `${sensors.voltage.toFixed(1)} V`} />
                      <Metric label={t("Current")} value={sensors?.current == null ? "—" : `${sensors.current.toFixed(2)} A`} />
                    </>
                  )}
                  {stageActive && stage.stage === "Separation" && (settling ? (
                    <Metric label={t("Settling in the reactor")} value={`${stage.settleRemainingSeconds ?? 0} s`} />
                  ) : (
                    <>
                      <Metric label={t("Centrifuge")} value={sensors?.centrifugeRpm == null ? "—" : `${sensors.centrifugeRpm.toLocaleString()} RPM`} sub={t("set speed")} />
                      <Metric label={t("Reactor pump")} value={sensors?.reactorValveOpen ? t("On") : t("Off")} />
                      <Metric label={t("Pumpin")} value={sensors?.centrifugeValveOpen ? t("On") : t("Off")} />
                    </>
                  ))}
                  {!stageActive && purifying && purification && (
                    <>
                      <Metric label={t("Temperature")} value={purification.liveTemperature == null ? "—" : `${purification.liveTemperature.toFixed(1)} °C`} />
                      {/* the stirrer's RPM reading (from the ESP32) is shown during methanol removal and contact */}
                      {(purification.phase === "methanol" || purification.phase === "contact") && (
                        <Metric label={t("Stirrer")} value={purification.stirrerOn ? `${purification.stirrerRpm ?? "—"} / ${purification.stirringSpeed} RPM` : t("Off")} />
                      )}
                      {purification.phase === "drain" && <Metric label={t("Collected")} value={`${(purification.outputWeightG ?? 0).toFixed(1)} g`} />}
                    </>
                  )}
                </div>
                {stageActive && stage.timeMinutes ? (
                  <div className="mt-5"><Progress value={(stage.elapsedSeconds / (stage.timeMinutes * 60)) * 100} /></div>
                ) : null}
                {pump && pump.pump && (
                  <p className="mt-5 text-xs text-gray-500">
                    {t("{pump} is emptying its container ({grams} g measured) into the reactor · {seconds} s. Press Done on the Process page when it is empty.", { pump: t(PUMP_LABELS[pump.pump]), grams: pump.targetG.toFixed(1), seconds: pump.elapsedSeconds })}
                  </p>
                )}
                <Link to="/process" className="btn-primary mt-5">{t("Continue Process")} →</Link>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/[0.1] bg-gv-inset px-6 py-10 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-green-500/10 text-green-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-6 w-6">
                    <path d="M12 5v14M5 12h14" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="font-display font-semibold text-white">{t("No active batch")}</div>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">
                  {t("Begin with the preparation and safety instructions, then follow each production stage in sequence.")}
                </p>
                <Link to="/process" className="btn-secondary mt-5">{t("Open Process")}</Link>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <Heading as="h2" className="text-lg font-semibold">{t("System Status")}</Heading>
            <span className="text-[10px] uppercase tracking-widest text-gray-600">{systemStatus ? t("Live") : t("Offline")}</span>
          </div>
          {!systemStatus && (
            <p className="mt-5 text-sm text-gray-500">{backend ? t("Reading the devices…") : t("The Raspberry Pi can't be reached. Check that it is on and on the same network, and that the Greenova service is running.")}</p>
          )}
          <div className="mt-5 space-y-1">
            {devices.map((device) => (
              <div key={device.label} className="flex items-center justify-between border-b border-white/[0.05] py-3 last:border-0">
                <span className="text-sm text-gray-400">{t(device.label)}</span>
                <Status tone={deviceTone(device.status)}>{t(device.status)}</Status>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-xl border border-green-500/10 bg-green-500/[0.04] p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">{t("Device readiness")}</span>
              <span className="font-mono text-green-400">{readiness}%</span>
            </div>
            <div className="mt-3"><Progress value={readiness} /></div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-5">
          <div>
            <Heading as="h2" className="text-lg font-semibold">{t("Recent Batch Performance")}</Heading>
            <p className="mt-1 text-xs text-gray-600">{source === "offline" ? t("Raspberry Pi offline") : t("Raspberry Pi records")}</p>
          </div>
          <Link to="/batches" className="text-sm font-medium text-green-400 hover:text-green-300">{t("View Batch History")} →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="gv-table min-w-[700px]">
            <thead><tr><th>{t("Batch")}</th><th>{t("Date")}</th><th>{t("Yield")}</th><th>{t("Duration")}</th><th>{t("Lab Test")}</th><th>{t("Status")}</th></tr></thead>
            <tbody>
              {recent.length > 0 ? (
                recent.map((batch) => {
                  const running = batch.status === "In Progress";
                  return (
                    <tr key={batch.id}>
                      <td className="font-mono !text-green-400">{running ? <Link to="/process">{batch.id}</Link> : batch.id}</td>
                      <td>{new Date(batch.date).toLocaleDateString()}</td>
                      <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                      <td>{running ? "—" : `${batch.duration} min`}</td>
                      <td>{running ? "—" : <Status tone={batch.labResult === "Passed" ? "green" : batch.labResult === "Failed" ? "red" : batch.labResult === "Pending" ? "yellow" : "neutral"}>{t(batch.labResult)}</Status>}</td>
                      <td>
                        <Status tone={batchTone(batch.status)}>{t(batch.status)}</Status>
                        {running && batch.currentStage && <div className="mt-1 text-[10px] text-gray-600">{t(batch.currentStage)}</div>}
                      </td>
                    </tr>
                  );
                })) : (
                  <tr>
                    <td colSpan={6} className="py-12 text-center">
                      <div className="flex flex-col items-center gap-2">
                        <p className="text-sm font-medium text-gray-400">
                          {t("No batch records yet")}
                        </p>
                        <p className="text-xs text-gray-600">
                          {t("Batch performance will appear here once records are available.")}
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
