import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, Heading, Metric, Progress, Status } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { getSystemStatus, useBatches, type SystemStatus } from "../lib/api";

const demoDevices = [
  { label: "Raspberry Pi", status: "Connected" },
  { label: "Temperature Sensor", status: "Connected" },
  { label: "Reaction Tank", status: "Ready" },
  { label: "Centrifuge", status: "Ready" },
  { label: "Dry Wash Filter", status: "Ready" },
];

function deviceTone(status: string) {
  if (["Fault", "No reading"].includes(status)) return "red" as const;
  if (["On", "Running", "Open"].includes(status)) return "yellow" as const;
  return "green" as const;
}

export default function Dashboard() {
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
  const purifying = purification !== null && ["heating", "hold", "flow", "drain"].includes(purification.phase);
  const activeBatchId = stageActive && stage ? stage.batchId : purifying && purification ? purification.batchId : null;
  const activeStage = stageActive && stage
    ? `${stage.stage} · ${stage.state}`
    : purifying && purification
      ? `Purification · ${purification.phase === "flow" ? "mesh bed flow" : purification.phase === "drain" ? "draining" : purification.phase === "hold" ? "holding" : purification.phase}`
      : null;
  const devices = systemStatus?.devices ?? demoDevices;
  const readiness = systemStatus?.readiness ?? 100;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">Production overview</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">Dashboard</Heading>
          <p className="mt-2 text-sm text-gray-500">A concise view of the current process, devices, and recent batch performance.</p>
        </div>
        <Link to="/process" className="btn-primary">Start New Process <span>→</span></Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5"><Metric label="Current Batch" value={activeBatchId || (activeStage ? "Unassigned" : "No active batch")} sub={activeStage ? "In progress" : "System ready"} /></Card>
        <Card className="p-5"><Metric label="Current Stage" value={activeStage ?? "—"} sub={activeStage ? (live?.mock ? "Demonstration backend" : "Live from the Raspberry Pi") : "Start a new process"} /></Card>
        <Card className="p-5"><Metric label="Total Batches" value={batches.length} sub={source === "backend" ? "Raspberry Pi records" : "Prototype dataset"} accent /></Card>
        <Card className="p-5"><Metric label="Success Rate" value={`${successRate.toFixed(1)}%`} sub="Completed batches" accent /></Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_0.65fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-4 border-b border-white/[0.06] p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <Heading as="h2" className="text-lg font-semibold">Current Process</Heading>
              <p className="mt-1 text-sm text-gray-500">{activeStage ? `${activeBatchId ?? "A batch"} is running.` : "No production batch is currently running."}</p>
            </div>
            {activeStage ? <Status tone="blue">In progress</Status> : <Status>System ready</Status>}
          </div>
          <div className="p-6">
            {activeStage !== null && stage !== null ? (
              <div className="rounded-xl border border-white/[0.07] bg-black/10 p-6">
                <div className="grid gap-5 sm:grid-cols-4">
                  <Metric label="Stage" value={stageActive ? stage.stage : "Purification"} />
                  <Metric label="Temperature" value={live?.sensors.temperature == null ? "—" : `${live.sensors.temperature.toFixed(1)} °C`} />
                  <Metric label="Voltage" value={live?.sensors.voltage == null ? "—" : `${live.sensors.voltage.toFixed(1)} V`} />
                  <Metric label="Current" value={live?.sensors.current == null ? "—" : `${live.sensors.current.toFixed(2)} A`} />
                </div>
                {stageActive && stage.timeMinutes ? (
                  <div className="mt-5"><Progress value={(stage.elapsedSeconds / (stage.timeMinutes * 60)) * 100} /></div>
                ) : null}
                <Link to="/process" className="btn-secondary mt-5">Open Process</Link>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-white/[0.1] bg-black/10 px-6 py-10 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-green-500/10 text-green-400">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="h-6 w-6">
                    <path d="M12 5v14M5 12h14" strokeWidth="1.7" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="font-display font-semibold text-white">No active batch</div>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">
                  Begin with the preparation and safety instructions, then follow each production stage in sequence.
                </p>
                <Link to="/process" className="btn-secondary mt-5">Open Process</Link>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between">
            <Heading as="h2" className="text-lg font-semibold">System Status</Heading>
            <span className="text-[10px] uppercase tracking-widest text-gray-600">{systemStatus ? "Live" : "Demo"}</span>
          </div>
          <div className="mt-5 space-y-1">
            {devices.map((device) => (
              <div key={device.label} className="flex items-center justify-between border-b border-white/[0.05] py-3 last:border-0">
                <span className="text-sm text-gray-400">{device.label}</span>
                <Status tone={deviceTone(device.status)}>{device.status}</Status>
              </div>
            ))}
          </div>
          <div className="mt-5 rounded-xl border border-green-500/10 bg-green-500/[0.04] p-4">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">Device readiness</span>
              <span className="font-mono text-green-400">{readiness}%</span>
            </div>
            <div className="mt-3"><Progress value={readiness} /></div>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-5">
          <div>
            <Heading as="h2" className="text-lg font-semibold">Recent Batch Performance</Heading>
            <p className="mt-1 text-xs text-gray-600">{source === "backend" ? "Raspberry Pi records" : "Sample prototype values"}</p>
          </div>
          <Link to="/batches" className="text-sm font-medium text-green-400 hover:text-green-300">View Batch History →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="gv-table min-w-[700px]">
            <thead><tr><th>Batch</th><th>Yield</th><th>Energy</th><th>Duration</th><th>Status</th></tr></thead>
            <tbody>
              {recent.map((batch) => (
                <tr key={batch.id}>
                  <td className="font-mono !text-green-400">{batch.id}</td>
                  <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                  <td>{batch.energy} kWh</td>
                  <td>{batch.duration} min</td>
                  <td><Status tone={batch.status === "Completed" ? "green" : "red"}>{batch.status}</Status></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
