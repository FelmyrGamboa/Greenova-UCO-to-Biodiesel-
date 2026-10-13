import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, Heading, Metric, Progress, Status } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { getSystemStatus, useBatches, type PurificationPhase, type SystemStatus } from "../lib/api";
import { useT } from "../lib/i18n";

const demoDevices = [
  { label: "Raspberry Pi", status: "Connected" },
  { label: "Temperature Sensor", status: "Connected" },
  { label: "Reaction Tank", status: "Ready" },
  { label: "Pump A (NaOH/KOH + methanol)", status: "Ready" },
  { label: "Pump B (H₂SO₄ + methanol)", status: "Ready" },
  { label: "Reactor outlet valve", status: "Closed" },
  { label: "Centrifuge", status: "Ready" },
  { label: "Centrifuge outlet valve", status: "Closed" },
  { label: "Dry wash stirrer", status: "Ready" },
  { label: "Purification outlet valve", status: "Closed" },
  { label: "Output load cell", status: "0.0 g" },
];

const PUMP_LABELS = { catalyst: "Pump A · NaOH/KOH + methanol", acid: "Pump B · H₂SO₄ + methanol" } as const;
const VALVE_LABELS = { reactor_outlet: "reactor outlet", centrifuge_outlet: "centrifuge outlet" } as const;
const PURIFICATION_STEP: Partial<Record<PurificationPhase, string>> = {
  heating: "Heating", methanol: "Methanol removal", magnesol: "Add adsorbent", contact: "Contact",
  settling: "Settling", cooling: "Cooling", drain: "Draining",
};

function deviceTone(status: string) {
  if (["Fault", "No reading"].includes(status)) return "red" as const;
  if (["On", "Running", "Open", "Pumping"].includes(status) || status.startsWith("Running")) return "yellow" as const;
  return "green" as const;
}

export default function Dashboard() {
  const t = useT();
  const { batches, source } = useBatches();
  const { live, backend } = useLiveData();
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const completed = batches.filter((batch) => batch.status === "Completed");
  const successRate = batches.length ? (completed.length / batches.length) * 100 : 0;
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
  const drain = live && (live.drain.phase === "waiting" || live.drain.phase === "draining") ? live.drain : null;
  const activeBatchId = stageActive && stage ? stage.batchId : purifying && purification ? purification.batchId
    : pump ? pump.batchId : drain ? drain.batchId : null;
  const activeStage = stageActive && stage && stage.stage
    ? `${t(stage.stage)} · ${t(stage.state)}`
    : purifying && purification
      ? `${t("Purification")} · ${t(PURIFICATION_STEP[purification.phase] ?? "")}`
      : pump && pump.pump
        ? `${t("Loading")} · ${pump.pump === "catalyst" ? t("pump A") : t("pump B")}`
        : drain && drain.valve
          ? `${t("Draining")} · ${t(VALVE_LABELS[drain.valve])}`
          : null;
  const sensors = live?.sensors;
  const devices = systemStatus?.devices ?? demoDevices;
  const readiness = systemStatus?.readiness ?? 100;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">{t("Production overview")}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Dashboard")}</Heading>
          <p className="mt-2 text-sm text-gray-500">{t("A concise view of the current process, devices, and recent batch performance.")}</p>
        </div>
        <Link to="/process" className="btn-primary">{t("Start New Process")} <span>→</span></Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5"><Metric label={t("Current Batch")} value={activeBatchId || (activeStage ? t("Unassigned") : t("No active batch"))} sub={activeStage ? t("In progress") : t("System ready")} /></Card>
        <Card className="p-5"><Metric label={t("Current Stage")} value={activeStage ?? "—"} sub={activeStage ? (live?.mock ? t("Demonstration backend") : t("Live from the Raspberry Pi")) : t("Start a new process")} /></Card>
        <Card className="p-5"><Metric label={t("Total Batches")} value={batches.length} sub={source === "backend" ? t("Raspberry Pi records") : t("Prototype dataset")} accent /></Card>
        <Card className="p-5"><Metric label={t("Success Rate")} value={`${successRate.toFixed(1)}%`} sub={t("Completed batches")} accent /></Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-white/[0.06] p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Heading as="h2" className="text-lg font-semibold">{t("Current Process")}</Heading>
              <p className="mt-1 text-sm text-gray-500">{activeStage ? t("{batch} is running.", { batch: activeBatchId ?? t("A batch") }) : t("No production batch is currently running.")}</p>
            </div>
            {activeStage ? <Status tone="blue">{t("In progress")}</Status> : <Status>{t("System ready")}</Status>}
          </div>
          <div className="p-6">
            {activeStage !== null && stage !== null ? (
              <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-6">
                {/* only the running stage's own live readings */}
                <div className="grid gap-5 sm:grid-cols-4">
                  <Metric label={t("Stage")} value={stageActive && stage.stage ? t(stage.stage) : purifying ? t("Purification") : pump ? t("Loading") : t("Draining")} />
                  {stageActive && stage.stage !== "Separation" && (
                    <>
                      <Metric label={t("Temperature")} value={sensors?.temperature == null ? "—" : `${sensors.temperature.toFixed(1)} °C`} />
                      <Metric label={t("Voltage")} value={sensors?.voltage == null ? "—" : `${sensors.voltage.toFixed(1)} V`} />
                      <Metric label={t("Current")} value={sensors?.current == null ? "—" : `${sensors.current.toFixed(2)} A`} />
                    </>
                  )}
                  {stageActive && stage.stage === "Separation" && (
                    <Metric label={t("Centrifuge")} value={sensors?.centrifugeRpm == null ? "—" : `${sensors.centrifugeRpm.toLocaleString()} RPM`} />
                  )}
                  {!stageActive && purifying && purification && (
                    <>
                      <Metric label={t("Temperature")} value={purification.liveTemperature == null ? "—" : `${purification.liveTemperature.toFixed(1)} °C`} />
                      <Metric label={t("Stirrer")} value={purification.stirrerOn ? `${purification.stirrerRpm ?? "—"} / ${purification.stirringSpeed} RPM` : t("Off")} />
                      {purification.phase === "drain" && <Metric label={t("Collected")} value={`${(purification.outputWeightG ?? 0).toFixed(1)} g`} />}
                    </>
                  )}
                </div>
                {stageActive && stage.timeMinutes ? (
                  <div className="mt-5"><Progress value={(stage.elapsedSeconds / (stage.timeMinutes * 60)) * 100} /></div>
                ) : null}
                {pump && pump.pump && (
                  <div className="mt-5">
                    <div className="mb-2 flex justify-between text-xs text-gray-500"><span>{t(PUMP_LABELS[pump.pump])}</span><span className="font-mono">{pump.deliveredG.toFixed(1)} / {pump.targetG.toFixed(1)} g</span></div>
                    <Progress value={pump.targetG ? (pump.deliveredG / pump.targetG) * 100 : 0} />
                  </div>
                )}
                {drain && drain.valve && (
                  <p className="mt-5 text-xs text-gray-500">
                    {drain.phase === "waiting" ? t("Waiting for the centrifuge to stop, then the {valve} opens.", { valve: t(VALVE_LABELS[drain.valve]) }) : t("The {valve} is open · {time} left.", { valve: t(VALVE_LABELS[drain.valve]), time: `${Math.floor(drain.remainingSeconds / 60)}:${String(drain.remainingSeconds % 60).padStart(2, "0")}` })}
                  </p>
                )}
                <Link to="/process" className="btn-secondary mt-5">{t("Open Process")}</Link>
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
            <span className="text-[10px] uppercase tracking-widest text-gray-600">{systemStatus ? t("Live") : t("Demo")}</span>
          </div>
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
            <p className="mt-1 text-xs text-gray-600">{source === "backend" ? t("Raspberry Pi records") : t("Sample prototype values")}</p>
          </div>
          <Link to="/batches" className="text-sm font-medium text-green-400 hover:text-green-300">{t("View Batch History")} →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="gv-table min-w-[700px]">
            <thead><tr><th>{t("Batch")}</th><th>{t("Yield")}</th><th>{t("Energy")}</th><th>{t("Duration")}</th><th>{t("Status")}</th></tr></thead>
            <tbody>
              {recent.length > 0 ? (
                recent.map((batch) => (
                  <tr key={batch.id}>
                    <td className="font-mono !text-green-400">{batch.id}</td>
                    <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                    <td>{batch.energy} kWh</td>
                    <td>{batch.duration} min</td>
                    <td><Status tone={batch.status === "Completed" ? "green" : "red"}>{t(batch.status)}</Status></td>
                  </tr>
                ))) : (
                  <tr>
                    <td colSpan={5} className="py-12 text-center">
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
              {/* {recent.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-mono !text-green-400">{batch.id}</td>
                  <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                  <td>{batch.energy} kWh</td>
                  <td>{batch.duration} min</td>
                  <td><Status tone={batch.status === "Completed" ? "green" : "red"}>{t(batch.status)}</Status></td>
                </tr>
              ))} */}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
