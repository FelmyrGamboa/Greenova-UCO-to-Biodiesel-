import { useEffect, useState } from "react";
import { Button, Card, Field, Heading, SelectField, Status } from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import { useTheme } from "../contexts/ThemeContext";
import { getBatches, getSystemStatus, isOffline, saveSettings, type SystemStatus } from "../lib/api";
import { DEFAULT_FFA_BOUNDARIES, ffaBoundaries } from "../lib/greenovaData";
import { useLanguage, type Language } from "../lib/i18n";

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

const DEFAULT_BATCH_FORMAT = "B-{YEAR}-{SEQ}";

export default function Settings() {
  const initialSettings = readSettings();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { backend } = useLiveData();
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [systemName, setSystemName] = useState(String(initialSettings.systemName || "Greenova Production System"));
  const [operator, setOperator] = useState(String(initialSettings.operator || "Operator 01"));
  const [units, setUnits] = useState(String(initialSettings.units || "metric"));
  // Empty field = the default format (shown as the placeholder), as in your version of this page.
  const [format, setFormat] = useState(
    initialSettings.format && initialSettings.format !== DEFAULT_BATCH_FORMAT ? String(initialSettings.format) : "",
  );
  const numberSetting = (key: string, fallback: number) => {
    const value = Number(initialSettings[key]);
    return String(initialSettings[key] !== undefined && initialSettings[key] !== null && Number.isFinite(value) ? value : fallback);
  };
  // Purification: only these four are settings; the 90 °C hold, 95 °C cutoff and 200 RPM are fixed.
  const [methanolRemovalTime, setMethanolRemovalTime] = useState(numberSetting("methanolRemovalTime", 10));
  const [contactTime, setContactTime] = useState(numberSetting("contactTime", 15));
  const [settlingTime, setSettlingTime] = useState(numberSetting("settlingTime", 10));
  const [maxDrainTemperature, setMaxDrainTemperature] = useState(numberSetting("maxDrainTemperature", 50));
  const [ffaRangeBoundaries, setFfaRangeBoundaries] = useState(ffaBoundaries(initialSettings.ffaRangeBoundaries).join(","));
  const [esterificationDesignFfa, setEsterificationDesignFfa] = useState(numberSetting("esterificationDesignFfa", 10));
  const [stripMaxFfa, setStripMaxFfa] = useState(numberSetting("stripMaxFfa", 5));
  const [pumpCatalystRate, setPumpCatalystRate] = useState(numberSetting("pumpCatalystRate", 100));
  const [pumpAcidRate, setPumpAcidRate] = useState(numberSetting("pumpAcidRate", 100));
  const [reactorDrainTime, setReactorDrainTime] = useState(numberSetting("reactorDrainTime", 1));
  const [centrifugeDrainTime, setCentrifugeDrainTime] = useState(numberSetting("centrifugeDrainTime", 3));
  const [centrifugeSpinDownTime, setCentrifugeSpinDownTime] = useState(numberSetting("centrifugeSpinDownTime", 30));
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
      format: format.trim() || DEFAULT_BATCH_FORMAT,
      methanolRemovalTime: Number(methanolRemovalTime),
      contactTime: Number(contactTime),
      settlingTime: Number(settlingTime),
      maxDrainTemperature: Number(maxDrainTemperature),
      esterificationDesignFfa: Number(esterificationDesignFfa),
      stripMaxFfa: Number(stripMaxFfa),
      pumpCatalystRate: Number(pumpCatalystRate),
      pumpAcidRate: Number(pumpAcidRate),
      reactorDrainTime: Number(reactorDrainTime),
      centrifugeDrainTime: Number(centrifugeDrainTime),
      centrifugeSpinDownTime: Number(centrifugeSpinDownTime),
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
      setSaveError(isOffline(error) ? t("Backend offline.") : t(error instanceof Error ? error.message : String(error)));
      return;
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  }

  const designFfa = Number(esterificationDesignFfa) || 10;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <div className="section-kicker">{t("System configuration")}</div>
        <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Settings")}</Heading>
        <p className="mt-2 text-sm text-gray-500">{t("Manage practical system, process, device, and data defaults.")}</p>
      </div>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("General")}</Heading>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Field label={t("System name")} value={systemName} onChange={(event) => setSystemName(event.target.value)} />
          <Field label={t("Operator / session")} value={operator} onChange={(event) => setOperator(event.target.value)} />
          <SelectField label={t("Interface theme")} value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}>
            <option value="dark">{t("Dark")}</option><option value="light">{t("Light")}</option>
          </SelectField>
          <SelectField label={t("Language")} value={language} onChange={(event) => setLanguage(event.target.value as Language)}>
            <option value="en">English</option><option value="fil">Filipino (Tagalog)</option>
          </SelectField>
          <SelectField label={t("Measurement units")} value={units} onChange={(event) => setUnits(event.target.value)}>
            <option value="metric">{t("Metric (mL, °C, g)")}</option><option value="imperial">{t("Imperial")}</option>
          </SelectField>
        </div>
        <p className="mt-3 text-xs text-gray-600">{t("The theme and the language change right away and are remembered in this browser.")}</p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Analytics")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Configure FFA grouping, proof thresholds, and prototype costing.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("FFA range boundaries")} value={ffaRangeBoundaries} onChange={(event) => setFfaRangeBoundaries(event.target.value)} placeholder={DEFAULT_FFA_BOUNDARIES} unit="%" />
          <Field label={t("Batches required for Proven")} type="number" min="1" value={provenBatchCount} onChange={(event) => setProvenBatchCount(event.target.value)} />
          <Field label={t("Yield tolerance")} type="number" min="0" value={provenYieldTolerance} onChange={(event) => setProvenYieldTolerance(event.target.value)} unit="± pp" />
          <Field label={t("Oil price")} type="number" min="0" value={oilPrice} onChange={(event) => setOilPrice(event.target.value)} unit="₱/L" />
          <Field label={t("Methanol price")} type="number" min="0" value={methanolPrice} onChange={(event) => setMethanolPrice(event.target.value)} unit="₱/L" />
          <Field label={t("KOH price")} type="number" min="0" value={kohPrice} onChange={(event) => setKohPrice(event.target.value)} unit="₱/kg" />
          <Field label={t("NaOH price")} type="number" min="0" value={naohPrice} onChange={(event) => setNaohPrice(event.target.value)} unit="₱/kg" />
          <Field label={t("Sulfuric acid price")} type="number" min="0" value={sulfuricAcidPrice} onChange={(event) => setSulfuricAcidPrice(event.target.value)} unit="₱/L" />
          <Field label={t("Acetone price")} type="number" min="0" value={acetonePrice} onChange={(event) => setAcetonePrice(event.target.value)} unit="₱/L" />
          <Field label={t("Bentonite price")} type="number" min="0" value={bentonitePrice} onChange={(event) => setBentonitePrice(event.target.value)} unit="₱/kg" />
          <Field label={t("Electricity price")} type="number" min="0" value={electricityPrice} onChange={(event) => setElectricityPrice(event.target.value)} unit="₱/kWh" />
          <Field label={t("Diesel price")} type="number" min="0" value={dieselPrice} onChange={(event) => setDieselPrice(event.target.value)} unit="₱/L" />
        </div>
        <p className="mt-3 text-xs text-gray-600">{t("Default FFA ranges: 0–2%, 2–4%, 4–5%, and 5% and above (the strip's darkest color).")}</p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Process Defaults")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Validated values can be entered once approved by the project team.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Temperature")} placeholder={t("Project-defined")} unit="°C" />
          <Field label={t("Reaction time")} placeholder={t("Project-defined")} unit="min" />
          <Field label={t("Stirring speed")} placeholder={t("Project-defined")} unit="RPM" />
          <Field label={t("Batch naming format")} value={format} placeholder={DEFAULT_BATCH_FORMAT} onChange={(event) => setFormat(event.target.value)} />
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Esterification and Dosing")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("The FFA strip reads only up to its darkest color, so every batch above 4% FFA gets one uniform esterification dose. A re-check after each stage decides the next step.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Design FFA for the dose")} type="number" min="4.1" max="30" step="0.5" value={esterificationDesignFfa} onChange={(event) => setEsterificationDesignFfa(event.target.value)} unit="%" />
          <Field label={t("Strip maximum (darkest color)")} type="number" min="1" step="0.5" value={stripMaxFfa} onChange={(event) => setStripMaxFfa(event.target.value)} unit="%" />
          <Field label={t("Pump A rate (NaOH/KOH + methanol)")} type="number" min="1" value={pumpCatalystRate} onChange={(event) => setPumpCatalystRate(event.target.value)} unit="mL/min" />
          <Field label={t("Pump B rate (H₂SO₄ + methanol)")} type="number" min="1" value={pumpAcidRate} onChange={(event) => setPumpAcidRate(event.target.value)} unit="mL/min" />
          <Field label={t("Reactor outlet open after transesterification")} type="number" min="0" value={reactorDrainTime} onChange={(event) => setReactorDrainTime(event.target.value)} unit="min" />
          <Field label={t("Centrifuge outlet open after separation")} type="number" min="0" value={centrifugeDrainTime} onChange={(event) => setCentrifugeDrainTime(event.target.value)} unit="min" />
          <Field label={t("Centrifuge spin-down wait")} type="number" min="0" value={centrifugeSpinDownTime} onChange={(event) => setCentrifugeSpinDownTime(event.target.value)} unit="s" />
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Uniform dose per 100 mL of oil at {design}% design FFA: {methanol} mL methanol and {acid} mL H₂SO₄. The pumps stop when the reactor load cell has gained the dose's weight; their rate only sets the time limit (and the dose time if the load cell has no reading). An outlet time of 0 means you move the liquid by hand. The spin-down wait is used only when the centrifuge has no RPM reading.", { design: designFfa, methanol: ((92 * designFfa) / 100 * 2.84).toFixed(1), acid: ((92 * designFfa) / 100 * 0.027).toFixed(2) })}
        </p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Purification")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Dry wash with Magnesol. It runs by itself after separation: heating, methanol removal, add Magnesol, contact, settling, cooling if needed, draining.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Methanol removal time")} type="number" min="5" max="30" value={methanolRemovalTime} onChange={(event) => setMethanolRemovalTime(event.target.value)} unit="min" />
          <Field label={t("Contact time")} type="number" min="1" max="60" value={contactTime} onChange={(event) => setContactTime(event.target.value)} unit="min" />
          <Field label={t("Settling time")} type="number" min="0" max="60" value={settlingTime} onChange={(event) => setSettlingTime(event.target.value)} unit="min" />
          <Field label={t("Max drain temperature")} type="number" min="30" max="85" value={maxDrainTemperature} onChange={(event) => setMaxDrainTemperature(event.target.value)} unit="°C" />
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Methanol removal: 5–30 min. Fixed: hold at 90 °C (±2 °C), heater cutoff 95 °C, stirrer 200 RPM, Magnesol = oil volume × 0.0092 g. The outlet valve opens only at or below the max drain temperature (the water filter's limit).")}
        </p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <Heading as="h2" className="text-lg font-semibold">{t("Device Status")}</Heading>
            <p className="mt-1 text-sm text-gray-500">{t("Current Raspberry Pi, sensor, and relay connections.")}</p>
          </div>
          {systemStatus ? (
            <Status tone={systemStatus.mode === "live" ? "green" : "yellow"}>{systemStatus.mode === "live" ? t("Connected") : t("Demonstration backend")}</Status>
          ) : (
            <Status tone="neutral">{t("Backend offline · demo values")}</Status>
          )}
        </div>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(systemStatus?.devices.map((device) => [device.label, device.status]) ?? [
            ["Raspberry Pi", "Connected"],
            ["Temperature sensor", "Connected"],
            ["Power relay", "Ready"],
            ["Stirrer relay", "Ready"],
            ["Centrifuge controller", "Ready"],
            ["Pump A (NaOH/KOH + methanol)", "Ready"],
            ["Pump B (H₂SO₄ + methanol)", "Ready"],
            ["Reactor outlet valve", "Closed"],
            ["Centrifuge outlet valve", "Closed"],
            ["Dry wash stirrer", "Ready"],
            ["Purification outlet valve", "Closed"],
            ["Output load cell", "0.0 g"],
          ]).map(([device, state]) => (
            <div key={device} className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-gv-inset p-4">
              <span className="text-sm text-gray-400">{t(device)}</span><Status tone={["Fault", "No reading"].includes(state) ? "red" : "green"}>{t(state)}</Status>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Data")}</Heading>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-gray-300">{backend ? t("Raspberry Pi batch storage") : t("Local batch storage")}</div>
            <p className="mt-1 text-xs text-gray-600">{backend ? t("Batch records and settings are stored on the Raspberry Pi (a copy of the settings stays in this browser).") : t("Batch records and settings are stored in this browser.")}</p>
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
          }}>{t("Export Batch Data")}</Button>
        </div>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save}>{t("Save Settings")}</Button>
        {saved && <span className="text-sm text-green-400">{backend ? t("Settings saved to the Raspberry Pi.") : t("Settings saved.")}</span>}
        {saveError && <span className="text-sm text-red-400">{t("Not saved:")} {saveError}</span>}
      </div>
    </div>
  );
}
