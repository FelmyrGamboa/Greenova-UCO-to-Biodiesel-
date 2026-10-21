import { useEffect, useState } from "react";
import { Button, Card, Field, Heading, SelectField, Status } from "../components/ui";
import HardwarePanel from "../components/HardwarePanel";
import { useLiveData } from "../contexts/LiveContext";
import { useTheme } from "../contexts/ThemeContext";
import { getBatches, getSystemStatus, isOffline, saveSettings, type SystemStatus } from "../lib/api";
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
  // Purification: only these two times are settings; the 90 °C hold, 95 °C cutoff and 200 RPM are
  // fixed. There is no settling or cooling step (their database columns are left as they are).
  const [methanolRemovalTime, setMethanolRemovalTime] = useState(numberSetting("methanolRemovalTime", 10));
  const [contactTime, setContactTime] = useState(numberSetting("contactTime", 10));
  const ffaRangeBoundaries = "0,4,5";
  // This process rule is fixed: both the direct path and post-esterification acceptance use 3%.
  const [ffaThreshold] = useState("3");
  const [oilMinimumVolumeMl, setOilMinimumVolumeMl] = useState(numberSetting("oilMinimumVolumeMl", 1500));
  const [oilMaximumVolumeMl, setOilMaximumVolumeMl] = useState(numberSetting("oilMaximumVolumeMl", 5000));
  // Separation defaults: each batch sets its own time and speed (Volume & Parameters), starting from these.
  const [separationTime, setSeparationTime] = useState(numberSetting("separationTime", 60));
  const [separationSpeed, setSeparationSpeed] = useState(String(Math.min(Number(numberSetting("separationSpeed", 2500)), 2500)));
  const [heaterPowerWatts, setHeaterPowerWatts] = useState(numberSetting("heaterPowerWatts", 900));
  const [esterificationDesignFfa, setEsterificationDesignFfa] = useState(numberSetting("esterificationDesignFfa", 10));
  const [stripMaxFfa] = useState("5");
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
      ["Methanol removal time", methanolRemovalTime], ["Contact time", contactTime],
      ["Transesterification FFA limit", ffaThreshold], ["Minimum batch volume", oilMinimumVolumeMl], ["Maximum batch volume", oilMaximumVolumeMl], ["Default separation time", separationTime], ["Default centrifuge speed", separationSpeed], ["Heater power", heaterPowerWatts], ["Design FFA for the dose", esterificationDesignFfa],
      ["Strip maximum (darkest color)", stripMaxFfa],
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
    if (Number(separationTime) < 1 || Number(separationTime) > 180) {
      setSaveError(t("Default separation time must be between 1 and 180 min."));
      return;
    }
    if (Number(separationSpeed) < 100 || Number(separationSpeed) > 2500) {
      setSaveError(t("Default centrifuge speed must be between 100 and 2500 RPM (the centrifuge's maximum)."));
      return;
    }
    const changes = {
      systemName,
      operator,
      units,
      format: format.trim() || DEFAULT_BATCH_FORMAT,
      methanolRemovalTime: Number(methanolRemovalTime),
      contactTime: Number(contactTime),
      ffaThreshold: Number(ffaThreshold),
      ffaTarget: Number(ffaThreshold),
      oilMinimumVolumeMl: Number(oilMinimumVolumeMl),
      oilMaximumVolumeMl: Number(oilMaximumVolumeMl),
      separationTime: Number(separationTime),
      separationSpeed: Number(separationSpeed),
      heaterPowerWatts: Number(heaterPowerWatts),
      esterificationDesignFfa: Number(esterificationDesignFfa),
      stripMaxFfa: Number(stripMaxFfa),
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
    };
    try {
      // Saved on the Raspberry Pi (and copied to this browser)
      await saveSettings(changes);
    } catch (error) {
      setSaveError(isOffline(error) ? t("The Raspberry Pi is offline, so nothing was saved. Try again when it is connected.") : t(error instanceof Error ? error.message : String(error)));
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
          <Field label={t("FFA range boundaries (fixed for 3% threshold)")} value={ffaRangeBoundaries} readOnly unit="%" />
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
        <p className="mt-3 text-xs text-gray-600">{t("Default FFA ranges (whole percent): 0–3% goes directly to transesterification, 4% is esterified, and 5% or above is recorded using the strip’s darkest color.")}</p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Process Defaults")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Validated values can be entered once approved by the project team.")}</p>
        <p className="mt-1 text-xs text-gray-600">{t("Separation time and centrifuge speed are set for each batch in Volume & Parameters; these are the values a new batch starts with (speed at most 2500 RPM).")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
          <Field label={t("Temperature")} placeholder={t("Project-defined")} unit="°C" />
          <Field label={t("Reaction time")} placeholder={t("Project-defined")} unit="min" />
          <Field label={t("Stirring speed")} placeholder={t("Project-defined")} unit="RPM" />
          <Field label={t("Target batch volume (1,500–5,000 mL)")} value={oilMinimumVolumeMl} onChange={wholeInput(setOilMinimumVolumeMl)} inputMode="numeric" pattern="[0-9]*" unit="mL" />
          <Field label={t("Maximum batch volume")} value={oilMaximumVolumeMl} onChange={wholeInput(setOilMaximumVolumeMl)} inputMode="numeric" pattern="[0-9]*" unit="mL" />
          <Field label={t("Default separation time")} value={separationTime} onChange={wholeInput(setSeparationTime)} inputMode="numeric" pattern="[0-9]*" unit="min" />
          <Field label={t("Default centrifuge speed")} value={separationSpeed} onChange={wholeInput(setSeparationSpeed)} inputMode="numeric" pattern="[0-9]*" unit="RPM" />
          <Field label={t("Heater power")} value={heaterPowerWatts} onChange={wholeInput(setHeaterPowerWatts)} inputMode="numeric" pattern="[0-9]*" unit="W" />
          <Field label={t("Batch naming format")} value={format} placeholder={DEFAULT_BATCH_FORMAT} onChange={(event) => setFormat(event.target.value)} />
        </div>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Esterification and Dosing")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("FFA of 3% or below goes straight to transesterification. FFA above 3% gets esterification first; after each stage, re-check and continue when FFA is 3% or below.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Direct and post-esterification FFA limit")} inputMode="numeric" pattern="[0-9]*" value="3" readOnly unit="%" />
          <Field label={t("Design FFA for the dose")} inputMode="numeric" pattern="[0-9]*" value={esterificationDesignFfa} onChange={wholeInput(setEsterificationDesignFfa)} unit="%" />
          <Field label={t("Strip maximum (darkest color; fixed at 5%)")} inputMode="numeric" value={stripMaxFfa} readOnly unit="%" />
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Uniform dose per 100 mL of oil at {design}% design FFA: {methanol} mL methanol and {acid} mL H₂SO₄. The operator measures the oil and each premix into its container; the oil pump and the dispensers empty them into the reactor and run until Done is pressed. After transesterification the mixture settles for 1 minute, then the reactor pump, the centrifuge and pumpin run together for the batch's separation time.", { design: designFfa, methanol: ((92 * designFfa) / 100 * 2.84).toFixed(1), acid: ((92 * designFfa) / 100 * 0.027).toFixed(2) })}
        </p>
      </Card>

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Purification")}</Heading>
        <p className="mt-1 text-sm text-gray-500">{t("Dry wash with Magnesol or bentonite (chosen for each batch in Volume & Parameters). It runs by itself after separation: heating to 90 °C (heater off there), methanol removal at 87–90 °C, add the adsorbent, contact (stirred at 200 RPM, heater off), settle for 1 minute, then the valve opens and pumpout runs until the output load cell is stable for 30 s.")}</p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("Methanol removal time")} inputMode="numeric" pattern="[0-9]*" value={methanolRemovalTime} onChange={wholeInput(setMethanolRemovalTime)} unit="min" />
          <Field label={t("Contact time")} inputMode="numeric" pattern="[0-9]*" value={contactTime} onChange={wholeInput(setContactTime)} unit="min" />
          <Field label={t("Magnesol dose")} inputMode="numeric" pattern="[0-9]*" value={magnesolDose} onChange={wholeInput(setMagnesolDose)} unit={t("% of oil")} />
          <Field label={t("Bentonite dose")} inputMode="numeric" pattern="[0-9]*" value={bentoniteDose} onChange={wholeInput(setBentoniteDose)} unit={t("% of oil")} />
          <SelectField label={t("Default adsorbent")} value={defaultAdsorbent} onChange={(event) => setDefaultAdsorbent(event.target.value)}>
            <option value="Magnesol">Magnesol</option>
            <option value="Bentonite">{t("Bentonite")}</option>
          </SelectField>
        </div>
        <p className="mt-3 text-xs leading-5 text-gray-600">
          {t("Methanol removal: 5–30 min. Doses: 1–10% of the oil weight (Magnesol 1% = oil volume × 0.0092 g; bentonite 2% = oil volume × 0.0184 g). Fixed: heater off at 90 °C, back on at 87 °C, heater cutoff 95 °C, stirrer 200 RPM, 1 min settle before the valve and pumpout.")}
        </p>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <Heading as="h2" className="text-lg font-semibold">{t("Device Status")}</Heading>
            <p className="mt-1 text-sm text-gray-500">{t("Current Raspberry Pi, sensor, and relay connections.")}</p>
          </div>
          {systemStatus ? (
            <Status tone="green">{t("Connected")}</Status>
          ) : (
            <Status tone="red">{t("Raspberry Pi offline")}</Status>
          )}
        </div>
        {!systemStatus && (
          <p className="mt-4 text-sm text-gray-500">{t("The Raspberry Pi can't be reached. Check that it is on and on the same network, and that the Greenova service is running.")}</p>
        )}
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(systemStatus?.devices.map((device) => [device.label, device.status]) ?? []).map(([device, state]) => (
            <div key={device} className="flex items-center justify-between rounded-xl border border-white/[0.07] bg-gv-inset p-4">
              <span className="text-sm text-gray-400">{t(device)}</span><Status tone={["Fault", "No reading"].includes(state) ? "red" : "green"}>{t(state)}</Status>
            </div>
          ))}
        </div>
      </Card>

      <HardwarePanel backend={backend} />

      <Card className="p-6">
        <Heading as="h2" className="text-lg font-semibold">{t("Data")}</Heading>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium text-gray-300">{t("Raspberry Pi batch storage")}</div>
            <p className="mt-1 text-xs text-gray-600">{t("Batch records and settings are stored on the Raspberry Pi (a copy of the settings stays in this browser).")}</p>
          </div>
          <Button variant="secondary" disabled={!backend} onClick={async () => {
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
        {saved && <span className="text-sm text-green-400">{t("Settings saved to the Raspberry Pi.")}</span>}
        {saveError && <span className="text-sm text-red-400">{t("Not saved:")} {saveError}</span>}
      </div>
    </div>
  );
}
