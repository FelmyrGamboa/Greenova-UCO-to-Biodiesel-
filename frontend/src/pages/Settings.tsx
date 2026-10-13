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

/** onChange for a number field: letters can't be typed; a decimal point can, and Save refuses it
 * ("Use whole numbers only"), so 2.5 never silently becomes 25. */
function wholeInput(setValue: (value: string) => void) {
  return (event: { target: { value: string } }) => {
    if (/^[\d.,]*$/.test(event.target.value)) setValue(event.target.value);
  };
}

/** A stored setting as a whole number (older versions allowed decimals). */
function whole(value: unknown, fallback: number) {
  const number = Number(value);
  return String(value !== undefined && value !== null && value !== "" && Number.isFinite(number) ? Math.round(number) : fallback);
}

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
  const numberSetting = (key: string, fallback: number) => whole(initialSettings[key], fallback);
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
  const [centrifugeDrainTime, setCentrifugeDrainTime] = useState(numberSetting("centrifugeDrainTime", 2));
  const [centrifugeSpinDownTime, setCentrifugeSpinDownTime] = useState(numberSetting("centrifugeSpinDownTime", 30));
  const [provenBatchCount, setProvenBatchCount] = useState(whole(initialSettings.provenBatchCount || 3, 3));
  const [provenYieldTolerance, setProvenYieldTolerance] = useState(whole(initialSettings.provenYieldTolerance || 2, 2));
  const [oilPrice, setOilPrice] = useState(whole(initialSettings.oilPrice || 45, 45));
  const [methanolPrice, setMethanolPrice] = useState(whole(initialSettings.methanolPrice || 70, 70));
  const [kohPrice, setKohPrice] = useState(whole(initialSettings.kohPrice || 180, 180));
  const [naohPrice, setNaohPrice] = useState(whole(initialSettings.naohPrice || 160, 160));
  const [sulfuricAcidPrice, setSulfuricAcidPrice] = useState(whole(initialSettings.sulfuricAcidPrice || 120, 120));
  const [acetonePrice, setAcetonePrice] = useState(whole(initialSettings.acetonePrice || 100, 100));
  const [bentonitePrice, setBentonitePrice] = useState(whole(initialSettings.bentonitePrice || 80, 80));
  const [electricityPrice, setElectricityPrice] = useState(whole(initialSettings.electricityPrice || 12, 12));
  const [dieselPrice, setDieselPrice] = useState(whole(initialSettings.dieselPrice || 55, 55));
  const [magnesolPrice, setMagnesolPrice] = useState(whole(initialSettings.magnesolPrice || 250, 250));
  // Dry wash adsorbent: doses in % of the oil weight, and which one a new batch starts with
  const [magnesolDose, setMagnesolDose] = useState(numberSetting("magnesolDose", 1));
  const [bentoniteDose, setBentoniteDose] = useState(numberSetting("bentoniteDose", 2));
  const [defaultAdsorbent, setDefaultAdsorbent] = useState(initialSettings.defaultAdsorbent === "Bentonite" ? "Bentonite" : "Magnesol");
  const [autoAdvance, setAutoAdvance] = useState(initialSettings.autoAdvance !== false);

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
    // Every number on this page is a whole number (no decimals).
    const numbers: Array<[string, string]> = [
      ["Methanol removal time", methanolRemovalTime], ["Contact time", contactTime], ["Settling time", settlingTime],
      ["Max drain temperature", maxDrainTemperature], ["Design FFA for the dose", esterificationDesignFfa],
      ["Strip maximum (darkest color)", stripMaxFfa], ["Pump A rate (NaOH/KOH + methanol)", pumpCatalystRate],
      ["Pump B rate (H₂SO₄ + methanol)", pumpAcidRate], ["Reactor outlet open after transesterification", reactorDrainTime],
      ["Centrifuge outlet open after separation", centrifugeDrainTime], ["Centrifuge spin-down wait", centrifugeSpinDownTime],
      ["Batches required for Proven", provenBatchCount], ["Yield tolerance", provenYieldTolerance], ["Oil price", oilPrice],
      ["Methanol price", methanolPrice], ["KOH price", kohPrice], ["NaOH price", naohPrice],
      ["Sulfuric acid price", sulfuricAcidPrice], ["Acetone price", acetonePrice], ["Bentonite price", bentonitePrice],
      ["Magnesol price", magnesolPrice], ["Electricity price", electricityPrice], ["Diesel price", dieselPrice],
      ["Magnesol dose", magnesolDose], ["Bentonite dose", bentoniteDose],
    ];
    const notWhole = numbers.filter(([, value]) => !/^\d+$/.test(value.trim())).map(([label]) => t(label));
    if (notWhole.length) {
      setSaveError(t("Use whole numbers only (no decimals): {fields}.", { fields: notWhole.join(", ") }));
      return;
    }
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
      magnesolPrice: Number(magnesolPrice),
      magnesolDose: Number(magnesolDose),
      bentoniteDose: Number(bentoniteDose),
      defaultAdsorbent: defaultAdsorbent as "Magnesol" | "Bentonite",
      autoAdvance,
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
          <Field label={t("Batches required for Proven")} inputMode="numeric" pattern="[0-9]*" value={provenBatchCount} onChange={wholeInput(setProvenBatchCount)} />
          <Field label={t("Yield tolerance")} inputMode="numeric" pattern="[0-9]*" value={provenYieldTolerance} onChange={wholeInput(setProvenYieldTolerance)} unit="± pp" />
          <Field label={t("Oil price")} inputMode="numeric" pattern="[0-9]*" value={oilPrice} onChange={wholeInput(setOilPrice)} unit="₱/L" />
          <Field label={t("Methanol price")} inputMode="numeric" pattern="[0-9]*" value={methanolPrice} onChange={wholeInput(setMethanolPrice)} unit="₱/L" />
          <Field label={t("KOH price")} inputMode="numeric" pattern="[0-9]*" value={kohPrice} onChange={wholeInput(setKohPrice)} unit="₱/kg" />
          <Field label={t("NaOH price")} inputMode="numeric" pattern="[0-9]*" value={naohPrice} onChange={wholeInput(setNaohPrice)} unit="₱/kg" />
          <Field label={t("Sulfuric acid price")} inputMode="numeric" pattern="[0-9]*" value={sulfuricAcidPrice} onChange={wholeInput(setSulfuricAcidPrice)} unit="₱/L" />
          <Field label={t("Acetone price")} inputMode="numeric" pattern="[0-9]*" value={acetonePrice} onChange={wholeInput(setAcetonePrice)} unit="₱/L" />
          <Field label={t("Bentonite price")} inputMode="numeric" pattern="[0-9]*" value={bentonitePrice} onChange={wholeInput(setBentonitePrice)} unit="₱/kg" />
          <Field label={t("Magnesol price")} inputMode="numeric" pattern="[0-9]*" value={magnesolPrice} onChange={wholeInput(setMagnesolPrice)} unit="₱/kg" />
          <Field label={t("Electricity price")} inputMode="numeric" pattern="[0-9]*" value={electricityPrice} onChange={wholeInput(setElectricityPrice)} unit="₱/kWh" />
          <Field label={t("Diesel price")} inputMode="numeric" pattern="[0-9]*" value={dieselPrice} onChange={wholeInput(setDieselPrice)} unit="₱/L" />
        </div>
        <p className="mt-3 text-xs text-gray-600">{t("Default FFA ranges (FFA is a whole percent): 0–1% (no esterification), 2–3%, 4%, and 5% and above (the strip's darkest color). All values on this page are whole numbers.")}</p>
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
        <p className="mt-1 text-sm text-gray-500">{t("FFA of 1% or below goes straight to transesterification. The FFA strip reads only up to its darkest color, so every batch above 1% FFA gets one uniform esterification dose. A re-check after each stage decides the next step.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Design FFA for the dose")} inputMode="numeric" pattern="[0-9]*" value={esterificationDesignFfa} onChange={wholeInput(setEsterificationDesignFfa)} unit="%" />
          <Field label={t("Strip maximum (darkest color)")} inputMode="numeric" pattern="[0-9]*" value={stripMaxFfa} onChange={wholeInput(setStripMaxFfa)} unit="%" />
          <Field label={t("Pump A rate (NaOH/KOH + methanol)")} inputMode="numeric" pattern="[0-9]*" value={pumpCatalystRate} onChange={wholeInput(setPumpCatalystRate)} unit="mL/min" />
          <Field label={t("Pump B rate (H₂SO₄ + methanol)")} inputMode="numeric" pattern="[0-9]*" value={pumpAcidRate} onChange={wholeInput(setPumpAcidRate)} unit="mL/min" />
          <Field label={t("Reactor outlet open after transesterification")} inputMode="numeric" pattern="[0-9]*" value={reactorDrainTime} onChange={wholeInput(setReactorDrainTime)} unit="min" />
          <Field label={t("Centrifuge outlet open after separation")} inputMode="numeric" pattern="[0-9]*" value={centrifugeDrainTime} onChange={wholeInput(setCentrifugeDrainTime)} unit="min" />
          <Field label={t("Centrifuge spin-down wait")} inputMode="numeric" pattern="[0-9]*" value={centrifugeSpinDownTime} onChange={wholeInput(setCentrifugeSpinDownTime)} unit="s" />
          <SelectField label={t("After each drain")} value={autoAdvance ? "auto" : "wait"} onChange={(event) => setAutoAdvance(event.target.value === "auto")}>
            <option value="auto">{t("Go on to the next stage by itself")}</option>
            <option value="wait">{t("Wait for the operator's Start")}</option>
          </SelectField>
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Uniform dose per 100 mL of oil at {design}% design FFA: {methanol} mL methanol and {acid} mL H₂SO₄. The pumps stop when the reactor load cell has gained the dose's weight; their rate only sets the time limit (and the dose time if the load cell has no reading). An outlet time of 0 means you move the liquid by hand. The spin-down wait is used only when the centrifuge has no RPM reading.", { design: designFfa, methanol: ((92 * designFfa) / 100 * 2.84).toFixed(1), acid: ((92 * designFfa) / 100 * 0.027).toFixed(2) })}
        </p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Purification")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Dry wash with Magnesol or bentonite (chosen for each batch in Volume & Parameters). It runs by itself after separation: heating, methanol removal, add the adsorbent, contact, settling, cooling if needed, draining.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Methanol removal time")} inputMode="numeric" pattern="[0-9]*" value={methanolRemovalTime} onChange={wholeInput(setMethanolRemovalTime)} unit="min" />
          <Field label={t("Contact time")} inputMode="numeric" pattern="[0-9]*" value={contactTime} onChange={wholeInput(setContactTime)} unit="min" />
          <Field label={t("Settling time")} inputMode="numeric" pattern="[0-9]*" value={settlingTime} onChange={wholeInput(setSettlingTime)} unit="min" />
          <Field label={t("Max drain temperature")} inputMode="numeric" pattern="[0-9]*" value={maxDrainTemperature} onChange={wholeInput(setMaxDrainTemperature)} unit="°C" />
          <Field label={t("Magnesol dose")} inputMode="numeric" pattern="[0-9]*" value={magnesolDose} onChange={wholeInput(setMagnesolDose)} unit={t("% of oil")} />
          <Field label={t("Bentonite dose")} inputMode="numeric" pattern="[0-9]*" value={bentoniteDose} onChange={wholeInput(setBentoniteDose)} unit={t("% of oil")} />
          <SelectField label={t("Default adsorbent")} value={defaultAdsorbent} onChange={(event) => setDefaultAdsorbent(event.target.value)}>
            <option value="Magnesol">Magnesol</option>
            <option value="Bentonite">{t("Bentonite")}</option>
          </SelectField>
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Methanol removal: 5–30 min. Doses: 1–10% of the oil weight (Magnesol 1% = oil volume × 0.0092 g; bentonite 2% = oil volume × 0.0184 g). Fixed: hold at 90 °C (±2 °C), heater cutoff 95 °C, stirrer 200 RPM. The outlet valve opens only at or below the max drain temperature (the water filter's limit).")}
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
