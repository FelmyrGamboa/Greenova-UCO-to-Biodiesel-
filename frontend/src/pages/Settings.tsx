import { useEffect, useState } from "react";
import { Button, Card, Field, Heading, SelectField, Status } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { useTheme } from "../contexts/ThemeContext";
import { getBatches, getSystemStatus, isOffline, saveSettings, type SystemStatus } from "../lib/api";

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

export default function Settings() {
  const initialSettings = readSettings();
  const { theme, setTheme } = useTheme();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { backend } = useLiveData();
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [systemName, setSystemName] = useState(String(initialSettings.systemName || "Greenova Production System"));
  const [operator, setOperator] = useState(String(initialSettings.operator || "Operator 01"));
  const [units, setUnits] = useState(String(initialSettings.units || "metric"));
  const [format, setFormat] = useState(String(initialSettings.format || "B-{YEAR}-{SEQ}"));
  const [purificationTargetTemperature, setPurificationTargetTemperature] = useState(
    String(initialSettings.purificationTargetTemperature || 70),
  );
  const [purificationMaximumTemperature, setPurificationMaximumTemperature] = useState(
    String(initialSettings.purificationMaximumTemperature || 75),
  );
  const [thermalFuseRating, setThermalFuseRating] = useState(
    String(initialSettings.thermalFuseRating || ""),
  );
  const [purificationHoldTime, setPurificationHoldTime] = useState(
    String(initialSettings.purificationHoldTime || 25),
  );
  const [meshBedFlowRate, setMeshBedFlowRate] = useState(String(initialSettings.meshBedFlowRate || 40));
  const [drainTime, setDrainTime] = useState(String(initialSettings.drainTime || 3));
  const [heatingTimeout, setHeatingTimeout] = useState(String(initialSettings.heatingTimeout || 10));
  const [ffaRangeBoundaries, setFfaRangeBoundaries] = useState(String(initialSettings.ffaRangeBoundaries || "0,2,4,6,8,10"));
  const [provenBatchCount, setProvenBatchCount] = useState(String(initialSettings.provenBatchCount || 3));
  const [provenYieldTolerance, setProvenYieldTolerance] = useState(String(initialSettings.provenYieldTolerance || 2));
  const [oilPrice, setOilPrice] = useState(String(initialSettings.oilPrice || 45));
  const [methanolPrice, setMethanolPrice] = useState(String(initialSettings.methanolPrice || 70));
  const [kohPrice, setKohPrice] = useState(String(initialSettings.kohPrice || 180));
  const [naohPrice, setNaohPrice] = useState(String(initialSettings.naohPrice || 160));
  const [sulfuricAcidPrice, setSulfuricAcidPrice] = useState(String(initialSettings.sulfuricAcidPrice || 120));
  const [acetonePrice, setAcetonePrice] = useState(String(initialSettings.acetonePrice || 100));
  const [bentonitePrice, setBentonitePrice] = useState(String(initialSettings.bentonitePrice || 80));
  const [electricityPrice, setElectricityPrice] = useState(String(initialSettings.electricityPrice || 12));
  const [dieselPrice, setDieselPrice] = useState(String(initialSettings.dieselPrice || 55));

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

  async function save() {
    setSaveError(null);
    const changes = {
      systemName,
      operator,
      units,
      format,
      purificationTargetTemperature: Number(purificationTargetTemperature),
      purificationMaximumTemperature: Number(purificationMaximumTemperature),
      thermalFuseRating: thermalFuseRating ? Number(thermalFuseRating) : null,
      purificationHoldTime: Number(purificationHoldTime),
      meshBedFlowRate: Number(meshBedFlowRate),
      drainTime: Number(drainTime),
      heatingTimeout: Number(heatingTimeout),
      ffaRangeBoundaries,
      provenBatchCount: Number(provenBatchCount),
      provenYieldTolerance: Number(provenYieldTolerance),
      oilPrice: Number(oilPrice),
      methanolPrice: Number(methanolPrice),
      kohPrice: Number(kohPrice),
      naohPrice: Number(naohPrice),
      sulfuricAcidPrice: Number(sulfuricAcidPrice),
      acetonePrice: Number(acetonePrice),
      bentonitePrice: Number(bentonitePrice),
      electricityPrice: Number(electricityPrice),
      dieselPrice: Number(dieselPrice),
    };
    try {
      // Saves to the Raspberry Pi and to this browser; offline, only to this browser.
      await saveSettings(changes);
    } catch (error) {
      setSaveError(isOffline(error) ? "Backend offline." : error instanceof Error ? error.message : String(error));
      return;
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <div className="section-kicker">System configuration</div>
        <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">Settings</Heading>
        <p className="mt-2 text-sm text-gray-500">Manage practical system, process, device, and data defaults.</p>
      </div>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">General</Heading>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field label="System name" value={systemName} onChange={(event) => setSystemName(event.target.value)} />
          <Field label="Operator / session" value={operator} onChange={(event) => setOperator(event.target.value)} />
          <SelectField label="Interface theme" value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}>
            <option value="dark">Dark</option><option value="light">Light</option>
          </SelectField>
          <SelectField label="Measurement units" value={units} onChange={(event) => setUnits(event.target.value)}>
            <option value="metric">Metric (mL, °C, g)</option><option value="imperial">Imperial</option>
          </SelectField>
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">Analytics</Heading>
        <p className="mt-1 text-sm text-gray-500">Configure FFA grouping, proof thresholds, and prototype costing.</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="FFA range boundaries" value={ffaRangeBoundaries} onChange={(event) => setFfaRangeBoundaries(event.target.value)} placeholder="0,2,4,6,8,10" unit="%" />
          <Field label="Batches required for Proven" type="number" min="1" value={provenBatchCount} onChange={(event) => setProvenBatchCount(event.target.value)} />
          <Field label="Yield tolerance" type="number" min="0" value={provenYieldTolerance} onChange={(event) => setProvenYieldTolerance(event.target.value)} unit="± pp" />
          <Field label="Oil price" type="number" min="0" value={oilPrice} onChange={(event) => setOilPrice(event.target.value)} unit="₱/L" />
          <Field label="Methanol price" type="number" min="0" value={methanolPrice} onChange={(event) => setMethanolPrice(event.target.value)} unit="₱/L" />
          <Field label="KOH price" type="number" min="0" value={kohPrice} onChange={(event) => setKohPrice(event.target.value)} unit="₱/kg" />
          <Field label="NaOH price" type="number" min="0" value={naohPrice} onChange={(event) => setNaohPrice(event.target.value)} unit="₱/kg" />
          <Field label="Sulfuric acid price" type="number" min="0" value={sulfuricAcidPrice} onChange={(event) => setSulfuricAcidPrice(event.target.value)} unit="₱/L" />
          <Field label="Acetone price" type="number" min="0" value={acetonePrice} onChange={(event) => setAcetonePrice(event.target.value)} unit="₱/L" />
          <Field label="Bentonite price" type="number" min="0" value={bentonitePrice} onChange={(event) => setBentonitePrice(event.target.value)} unit="₱/kg" />
          <Field label="Electricity price" type="number" min="0" value={electricityPrice} onChange={(event) => setElectricityPrice(event.target.value)} unit="₱/kWh" />
          <Field label="Diesel price" type="number" min="0" value={dieselPrice} onChange={(event) => setDieselPrice(event.target.value)} unit="₱/L" />
        </div>
        <p className="mt-3 text-xs text-gray-600">Default FFA ranges: 0–2%, 2–4%, 4–6%, 6–8%, 8–10%, and above 10%.</p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">Process Defaults</Heading>
        <p className="mt-1 text-sm text-gray-500">Validated values can be entered once approved by the project team.</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Temperature" placeholder="Project-defined" unit="°C" />
          <Field label="Reaction time" placeholder="Project-defined" unit="min" />
          <Field label="Stirring speed" placeholder="Project-defined" unit="RPM" />
          <Field label="Batch naming format" value={format} onChange={(event) => setFormat(event.target.value)} />
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">Purification</Heading>
        <p className="mt-1 text-sm text-gray-500">Purification runs by itself after separation: heat to the target, hold, mesh bed flow, then drain.</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            label="Purification target temperature"
            type="number"
            min="40"
            max="70"
            value={purificationTargetTemperature}
            onChange={(event) => setPurificationTargetTemperature(event.target.value)}
            unit="°C"
          />
          <Field
            label="Maximum temperature cutoff"
            type="number"
            min="1"
            value={purificationMaximumTemperature}
            onChange={(event) => setPurificationMaximumTemperature(event.target.value)}
            unit="°C"
          />
          <Field
            label="Thermal fuse rating"
            type="number"
            min="1"
            placeholder="Enter rating"
            value={thermalFuseRating}
            onChange={(event) => setThermalFuseRating(event.target.value)}
            unit="°C"
          />
          <Field
            label="Hold at target"
            type="number"
            min="1"
            value={purificationHoldTime}
            onChange={(event) => setPurificationHoldTime(event.target.value)}
            unit="min"
          />
          <Field
            label="Mesh bed flow rate"
            type="number"
            min="1"
            value={meshBedFlowRate}
            onChange={(event) => setMeshBedFlowRate(event.target.value)}
            unit="mL/min"
          />
          <Field
            label="Drain time (at most)"
            type="number"
            min="0"
            value={drainTime}
            onChange={(event) => setDrainTime(event.target.value)}
            unit="min"
          />
          <Field
            label="Heating time limit"
            type="number"
            min="1"
            value={heatingTimeout}
            onChange={(event) => setHeatingTimeout(event.target.value)}
            unit="min"
          />
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          Target temperature allowed range: 40–70 °C. Flow time = batch volume ÷ flow rate (the biodiesel volume is about the oil volume), e.g. 500 mL ÷ {Number(meshBedFlowRate) || 40} mL/min = {(500 / (Number(meshBedFlowRate) || 40)).toFixed(1)} min. Draining ends when nothing more comes out for 1 minute. The heater stops if the target isn't reached within the heating time limit.
        </p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <Heading as="h2" className="text-lg font-semibold">Device Status</Heading>
            <p className="mt-1 text-sm text-gray-500">Current Raspberry Pi, sensor, and relay connections.</p>
          </div>
          {systemStatus ? (
            <Status tone={systemStatus.mode === "live" ? "green" : "yellow"}>{systemStatus.mode === "live" ? "Connected" : "Demonstration backend"}</Status>
          ) : (
            <Status tone="neutral">Backend offline · demo values</Status>
          )}
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(systemStatus?.devices.map((device) => [device.label, device.status]) ?? [
            ["Raspberry Pi", "Connected"],
            ["Temperature sensor", "Connected"],
            ["Power relay", "Ready"],
            ["Stirrer relay", "Ready"],
            ["Centrifuge controller", "Ready"],
            ["Drain control", "Ready"],
          ]).map(([device, state]) => (
            <div key={device} className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-black/10 p-4">
              <span className="text-sm text-gray-400">{device}</span><Status tone={["Fault", "No reading"].includes(state) ? "red" : "green"}>{state}</Status>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">Data</Heading>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-gray-300">{backend ? "Raspberry Pi batch storage" : "Local batch storage"}</div>
            <p className="mt-1 text-xs text-gray-600">{backend ? "Batch records and settings are stored on the Raspberry Pi (a copy of the settings stays in this browser)." : "Batch records and settings are stored in this browser."}</p>
          </div>
          <Button variant="secondary" onClick={async () => {
            const batches = await getBatches().catch(() => []);
            const blob = new Blob([JSON.stringify(batches, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "greenova-batches.json";
            anchor.click();
            URL.revokeObjectURL(url);
          }}>Export Batch Data</Button>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save}>Save Settings</Button>
        {saved && <span className="text-sm text-green-400">Settings saved{backend ? " to the Raspberry Pi" : ""}.</span>}
        {saveError && <span className="text-sm text-red-400">Not saved: {saveError}</span>}
      </div>
    </div>
  );
}
