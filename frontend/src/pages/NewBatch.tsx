import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Button,
  Card,
  Field,
  Heading,
  Metric,
  Progress,
  SelectField,
  Status,
} from "../components/ui";
import { useLiveData } from "../contexts/LiveContext";
import {
  demoAdd,
  drainAction,
  getNextBatchId,
  getRecommendedParametersForFfa,
  getSystemStatus,
  isOffline,
  loadDemoOil,
  pumpAction,
  purificationAction,
  saveCompletedBatch,
  stageAction,
  startDrain,
  startPump,
  startPurification,
  startStage,
  type BatchRecord,
  type DrainPhase,
  type DrainValve,
  type PumpName,
  type PumpPhase,
  type StageName,
  type StageStatus,
  type SystemStatus,
} from "../lib/api";
import { formatFfa } from "../lib/greenovaData";

type DeviceState = "ready" | "checking" | "fault";
type StageState = "ready" | "running" | "paused" | "complete" | "fault";
type PurificationPhase = "ready" | "heating" | "hold" | "flow" | "drain" | "complete" | "fault";
const PURIFYING: PurificationPhase[] = ["heating", "hold", "flow", "drain"];
type ChemistrySettings = {
  oilMolarMass: number;
  kohPurity: number;
  naohPurity: number;
  /** FFA every first esterification stage is dosed for (the strip can't read above stripMaxFfa). */
  designFfa: number;
  stripMaxFfa: number;
  /** Esterification goes on until the FFA re-check is at or below this. */
  ffaTarget: number;
};
type EsterStageRecord = {
  stage: number;
  ffaBefore: number;
  ffaAfter: number | null;
  doseFfa: number;
  methanolMl: number;
  sulfuricAcidMl: number;
  acetoneMl: number;
};

export const PROCESS_CONFIG = {
  oil: {
    minimumVolumeMl: 100,
    maximumVolumeMl: 1000,
    densityGPerMl: 0.92,
    averageTriglycerideMolecularWeight: 885,
  },
  ffaThreshold: 4,
  methanol: {
    ratioDefault: 7,
    ratioMin: 6,
    ratioMax: 9,
    molecularWeight: 32.04,
    densityGPerMl: 0.792,
    convention: "Molar methanol-to-triglyceride-oil ratio",
  },
  catalyst: {
    loadingDefault: 0.01,
  },
  acetone: {
    volumeFractionDefault: 0.1,
    provisional: true,
  },
  esterification: {
    voltage: { min: 18, max: 30, default: 20 },
    time: { min: 30, max: 120, default: 120 },
    stirring: { min: 400, max: 700, default: 500 },
    sulfuricAcidDosage: null,
  },
  transesterification: {
    voltage: { min: 18, max: 30, default: 30 },
    time: { min: 30, max: 180, default: 120 },
    stirring: { min: 400, max: 700, default: 500 },
  },
  separation: {
    timeMinutes: 10,
    speedRpm: 2600,
  },
} as const;

const SAFETY_GROUPS = [
  {
    title: "Chemical Handling",
    items: [
      ["Methanol", "Toxic and highly flammable. Keep away from ignition sources and use suitable ventilation."],
      ["Sulfuric acid (H₂SO₄)", "Corrosive. Use appropriate chemical-resistant PPE and the approved dilution and handling procedure."],
      ["NaOH or KOH", "Corrosive alkaline catalysts. Handle according to the laboratory procedure."],
      ["Acetone", "Highly flammable. Keep away from ignition sources and use suitable ventilation."],
      ["Chemical mixing", "Follow the validated order of addition. Do not mix incompatible chemicals or add chemicals without the approved procedure."],
      ["Containers", "Use compatible, closed, clearly labeled containers."],
    ],
  },
  {
    title: "Electrical and Process Safety",
    items: [
      ["Isolation", "Turn off and isolate the power supply before touching electrodes or reactor connections."],
      ["Electronics", "Keep electronics protected from spills, liquid, and chemical vapors."],
      ["Monitoring", "Monitor voltage, current, and temperature during the reaction."],
      ["Attendance", "Never leave an operating batch unattended."],
      ["Interlocks", "Stop the process if an interlock or configured safety limit is triggered."],
    ],
  },
  {
    title: "Emergency Response",
    items: [
      ["Spills", "Follow the laboratory's chemical-specific spill response procedure."],
      ["Skin or eye contact", "Immediately use the appropriate emergency washing equipment and seek medical assistance."],
      ["Fire", "Activate the emergency procedure and use only an appropriate extinguisher if trained and safe to do so."],
      ["Emergency equipment", "Know the location of the emergency stop, eyewash, safety shower, and fire extinguisher."],
    ],
  },
];

function decimalError(
  value: string,
  limits: { min: number; max: number },
  messages?: { empty?: string; min?: string; max?: string },
) {
  if (!value.trim() || !/^(?:\d+\.?\d*|\.\d+)$/.test(value)) {
    return messages?.empty ?? "Enter a valid numeric value.";
  }
  const number = Number(value);
  if (number < limits.min) return messages?.min ?? `Minimum value is ${limits.min}.`;
  if (number > limits.max) return messages?.max ?? `Maximum value is ${limits.max}.`;
  return "";
}

function errorText(error: unknown) {
  if (isOffline(error)) return "Backend offline. Check that the Greenova backend is running.";
  return error instanceof Error ? error.message : String(error);
}

function getChemistrySettings(): ChemistrySettings {
  const defaults = { oilMolarMass: 880, kohPurity: 90, naohPurity: 98, designFfa: 10, stripMaxFfa: 5, ffaTarget: 1 };
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    const positiveNumber = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
      oilMolarMass: positiveNumber(settings.oilMolarMass, defaults.oilMolarMass),
      kohPurity: positiveNumber(settings.kohPurity, defaults.kohPurity),
      naohPurity: positiveNumber(settings.naohPurity, defaults.naohPurity),
      designFfa: positiveNumber(settings.esterificationDesignFfa, defaults.designFfa),
      stripMaxFfa: positiveNumber(settings.stripMaxFfa, defaults.stripMaxFfa),
      ffaTarget: positiveNumber(settings.ffaTarget, defaults.ffaTarget),
    };
  } catch {
    return defaults;
  }
}

/** Pumps and outlet valves (Settings → Esterification and Dosing). */
function getTransferSettings() {
  const defaults = { reactorDrainMinutes: 3, centrifugeDrainMinutes: 3, stirringSpeed: 300 };
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    const nonNegative = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return value !== undefined && value !== null && value !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
    };
    return {
      reactorDrainMinutes: nonNegative(settings.reactorDrainTime, defaults.reactorDrainMinutes),
      centrifugeDrainMinutes: nonNegative(settings.centrifugeDrainTime, defaults.centrifugeDrainMinutes),
      stirringSpeed: nonNegative(settings.purificationStirringSpeed, defaults.stirringSpeed),
    };
  } catch {
    return defaults;
  }
}

function getPurificationSettings() {
  const defaults = {
    targetTemperature: 70,
    maximumTemperature: 75,
    thermalFuseRating: null as number | null,
    holdTimeMinutes: 25,
    flowRateMlPerMinute: 40,
    drainTimeMinutes: 3,
    heatingTimeoutMinutes: 10,
  };
  try {
    const settings = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
    const positiveNumber = (value: unknown, fallback: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const fuse = Number(settings.thermalFuseRating);
    return {
      targetTemperature: Math.min(70, Math.max(40, positiveNumber(settings.purificationTargetTemperature, defaults.targetTemperature))),
      maximumTemperature: positiveNumber(settings.purificationMaximumTemperature, defaults.maximumTemperature),
      thermalFuseRating: Number.isFinite(fuse) && fuse > 0 ? fuse : defaults.thermalFuseRating,
      holdTimeMinutes: positiveNumber(settings.purificationHoldTime, defaults.holdTimeMinutes),
      flowRateMlPerMinute: positiveNumber(settings.meshBedFlowRate, defaults.flowRateMlPerMinute),
      drainTimeMinutes: positiveNumber(settings.drainTime, defaults.drainTimeMinutes),
      heatingTimeoutMinutes: positiveNumber(settings.heatingTimeout, defaults.heatingTimeoutMinutes),
    };
  } catch {
    return defaults;
  }
}

type PurificationSettings = ReturnType<typeof getPurificationSettings>;

/** Mesh bed flow time: the biodiesel volume (about the oil volume) ÷ the flow rate, at least 2 min.
 * Same rule as the backend. */
function plannedFlowSecondsFor(volumeMl: number | null, settings: PurificationSettings) {
  const volume = volumeMl && volumeMl > 0 ? volumeMl : PROCESS_CONFIG.oil.maximumVolumeMl;
  return Math.round(Math.max(volume / settings.flowRateMlPerMinute, 2) * 60);
}

function formatMinutes(seconds: number) {
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

/** Local demonstration of the automatic purification (no backend): same phases and rules. */
type LocalPurification = {
  phase: PurificationPhase;
  temperature: number;
  highest: number;
  heaterOn: boolean;
  heatingSeconds: number;
  holdRemaining: number;
  plannedFlow: number;
  flowElapsed: number;
  drainElapsed: number;
  stableSeconds: number;
  outputG: number;
  tankG: number;
  rateGPerMinute: number;
  expectedG: number;
  warning: string | null;
  stopReason: string | null;
};

function stepLocalPurification(sim: LocalPurification, settings: PurificationSettings, target: number) {
  const fault = (reason: string) => {
    sim.phase = "fault";
    sim.heaterOn = false;
    sim.stopReason = reason;
  };
  const passMeshBed = () => {
    const moved = Math.min(sim.tankG, 0.59); // about 40 mL/min of biodiesel
    sim.tankG -= moved;
    sim.outputG = Number((sim.outputG + moved).toFixed(1));
    sim.rateGPerMinute = Number((moved * 60).toFixed(1));
    sim.stableSeconds = moved < 0.5 ? sim.stableSeconds + 1 : 0;
  };
  sim.temperature = Number((sim.temperature + (sim.heaterOn ? 0.75 : -0.1)).toFixed(1));
  sim.highest = Math.max(sim.highest, sim.temperature);
  if (sim.temperature > settings.maximumTemperature) return fault(`temperature exceeded ${settings.maximumTemperature} °C`);
  if (sim.phase === "heating") {
    sim.heatingSeconds += 1;
    if (sim.temperature >= target) {
      sim.phase = "hold";
    } else if (sim.heatingSeconds >= settings.heatingTimeoutMinutes * 60) {
      fault(`target not reached within ${settings.heatingTimeoutMinutes} min`);
    }
  } else if (sim.phase === "hold") {
    if (sim.temperature <= target - 1) sim.heaterOn = true;
    if (sim.temperature >= target + 1) sim.heaterOn = false;
    sim.holdRemaining = Math.max(sim.holdRemaining - 1, 0);
    if (sim.holdRemaining === 0) {
      sim.heaterOn = false;
      sim.phase = "flow";
    }
  } else if (sim.phase === "flow") {
    passMeshBed();
    sim.flowElapsed += 1;
    if (sim.flowElapsed >= sim.plannedFlow) {
      sim.phase = "drain";
      sim.stableSeconds = 0;
    }
  } else if (sim.phase === "drain") {
    passMeshBed();
    sim.drainElapsed += 1;
    if (sim.stableSeconds >= 60 || sim.drainElapsed >= settings.drainTimeMinutes * 60) finishLocalPurification(sim);
  }
}

function finishLocalPurification(sim: LocalPurification) {
  sim.phase = "complete";
  sim.rateGPerMinute = 0;
  if (sim.expectedG > 0 && sim.outputG < 0.5 * sim.expectedG) {
    sim.warning = `Only ${sim.outputG.toFixed(0)} g came out of about ${sim.expectedG.toFixed(0)} g expected. Check the mesh bed for clogging.`;
  }
}

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(Math.max(totalSeconds, 0) / 60);
  const seconds = Math.max(totalSeconds, 0) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

const METHANOL_DENSITY = 0.792;
const ACETONE_DENSITY = 0.784;

/** One esterification stage (same rules as the backend's calculations.py). Stage 1 is the uniform
 * dose for the design FFA (default 10%), because the strip can't read above 5%. Later stages are
 * dosed for the re-check reading, at 40:1 methanol to FFA; the acetone from stage 1 is still there. */
function esterificationDose(
  oilMassG: number,
  oilVolumeMl: number | null,
  ffa: number,
  stage: number,
  settings: ChemistrySettings,
) {
  const doseFfa = stage === 1 ? settings.designFfa : ffa;
  const ffaMassG = oilMassG * (doseFfa / 100);
  const methanolMl = ffaMassG * (stage === 1 ? 2.84 : 5.68);
  const sulfuricAcidMl = ffaMassG * 0.027;
  const sulfuricAcidG = ffaMassG * 0.05;
  const acetoneMl = stage === 1 && oilVolumeMl !== null ? oilVolumeMl * 0.1 : 0;
  return {
    stage,
    doseFfa,
    uniform: stage === 1,
    ffaMassG,
    methanolMl,
    sulfuricAcidMl,
    sulfuricAcidG,
    acetoneMl,
    acetoneG: acetoneMl * ACETONE_DENSITY,
    // pump B premix: what the reactor load cell should gain
    premixMl: methanolMl + sulfuricAcidMl,
    premixG: methanolMl * METHANOL_DENSITY + sulfuricAcidG,
  };
}

/** Transesterification. acidPct = the last FFA re-check (exact), or the starting FFA. */
function transesterificationDose(
  oilMassG: number,
  oilVolumeMl: number | null,
  acidPct: number,
  ratio: number,
  catalyst: "NaOH" | "KOH",
  settings: ChemistrySettings,
) {
  const catalystBaseG = oilMassG * 0.01;
  const neutralizationG = oilMassG * (acidPct / 100) * (catalyst === "KOH" ? 0.199 : 0.142);
  const purity = catalyst === "KOH" ? settings.kohPurity : settings.naohPurity;
  const methanolMl = (oilMassG * ratio * 40.45) / settings.oilMolarMass;
  const catalystToWeighG = (catalystBaseG + neutralizationG) / (purity / 100);
  const acetoneMl = oilVolumeMl === null ? null : oilVolumeMl * 0.1;
  return {
    methanolMl,
    catalystBaseG,
    neutralizationG,
    catalystToWeighG,
    purity,
    acetoneMl,
    acetoneG: (acetoneMl ?? 0) * ACETONE_DENSITY,
    // pump A premix (the dissolved catalyst barely changes the volume)
    premixMl: methanolMl,
    premixG: methanolMl * METHANOL_DENSITY + catalystToWeighG,
  };
}

type EsterDose = ReturnType<typeof esterificationDose>;
type TransDose = ReturnType<typeof transesterificationDose>;

function calculateQuantityCards(
  oilMassG: number,
  oilVolumeMl: number | null,
  ffa: number,
  ratio: number,
  catalyst: "NaOH" | "KOH",
  settings: ChemistrySettings,
) {
  const esterificationNeeded = ffa > PROCESS_CONFIG.ffaThreshold;
  const ester = esterificationDose(oilMassG, oilVolumeMl, ffa, 1, settings);
  // With esterification the catalyst is an "up to" amount (neutralizing the 1% target); the
  // exact amount comes after the FFA re-check.
  const trans = transesterificationDose(oilMassG, oilVolumeMl, esterificationNeeded ? settings.ffaTarget : ffa, ratio, catalyst, settings);

  return {
    ffaMassG: ester.ffaMassG,
    doseFfa: ester.doseFfa,
    esterificationNeeded,
    esterificationMethanolMl: ester.methanolMl,
    sulfuricAcidMl: ester.sulfuricAcidMl,
    acetoneMl: oilVolumeMl === null ? null : oilVolumeMl * 0.1,
    esterificationPremixG: ester.premixG,
    transesterificationMethanolMl: trans.methanolMl,
    catalystBaseG: trans.catalystBaseG,
    neutralizationG: trans.neutralizationG,
    catalystToWeighG: trans.catalystToWeighG,
    purity: trans.purity,
    transesterificationPremixG: trans.premixG,
  };
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <div className="section-kicker">{eyebrow}</div>
      <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">
        {title}
      </Heading>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">{description}</p>
    </div>
  );
}

function StateDot({ state }: { state: DeviceState }) {
  const color =
    state === "ready"
      ? "bg-gv-green"
      : state === "checking"
        ? "bg-amber-400"
        : "bg-red-500";
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />;
}

function ReadOnlyTile({
  label,
  value,
  secondary,
  state = "ready",
}: {
  label: string;
  value: string;
  secondary?: string;
  state?: DeviceState;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="gv-label !mb-0">{label}</div>
        <div className="flex items-center gap-2">
          <StateDot state={state} />
          <span className="text-[9px] font-bold uppercase tracking-wider text-gray-500">
            {state}
          </span>
        </div>
      </div>
      <div className="mt-3 font-display text-base font-semibold text-white">{value}</div>
      {secondary && <div className="mt-1 text-xs leading-5 text-gray-500">{secondary}</div>}
    </div>
  );
}

function Stepper({ steps, step }: { steps: string[]; step: number }) {
  return (
    <Card className="overflow-x-auto p-4 sm:p-5">
      <div className="flex min-w-[900px] items-start">
        {steps.map((label, index) => {
          const active = step === index;
          const complete = step > index;
          return (
            <div key={label} className="relative flex flex-1 flex-col items-center text-center">
              {index < steps.length - 1 && (
                <div
                  className={`absolute left-1/2 top-4 h-px w-full ${
                    complete ? "bg-green-500/60" : "bg-white/[0.08]"
                  }`}
                />
              )}
              <div
                className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold ${
                  complete
                    ? "border-green-500 bg-green-500 text-black"
                    : active
                      ? "border-green-400 bg-green-500/15 text-green-400 ring-4 ring-green-500/[0.06]"
                      : "border-white/10 bg-gv-surface text-gray-600"
                }`}
              >
                {complete ? "✓" : String(index + 1).padStart(2, "0")}
              </div>
              <div
                className={`mt-2 max-w-24 text-[10px] font-medium leading-4 ${
                  active ? "text-white" : complete ? "text-green-400" : "text-gray-600"
                }`}
              >
                {label}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ParameterField({
  label,
  value,
  setValue,
  unit,
  limits,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  unit: string;
  limits: { min: number; max: number };
}) {
  const error = decimalError(value, limits);
  return (
    <div>
      <Field
        label={label}
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        unit={unit}
        aria-invalid={Boolean(error)}
      />
      <p className={`mt-2 text-xs ${error ? "text-red-400" : "text-gray-600"}`}>
        {error || `Allowed range: ${limits.min}–${limits.max} ${unit}`}
      </p>
    </div>
  );
}

function StageControls({
  state,
  setState,
  startLabel,
  onContinue,
  continueLabel,
  onReset,
  error,
  startBlocked,
  hideContinue = false,
}: {
  state: StageState;
  setState: (state: StageState) => void;
  startLabel: string;
  onContinue: () => void;
  continueLabel: string;
  onReset?: () => void;
  error?: string | null;
  /** Why the stage can't start yet (e.g. the dose isn't loaded), or nothing. */
  startBlocked?: string | null;
  hideContinue?: boolean;
}) {
  if (state === "complete" && hideContinue) {
    // the next step is in the panel below (the FFA re-check)
    return error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null;
  }
  return (
    <>
    <div className="mt-7 flex flex-wrap items-center gap-3">
      {state === "ready" && <Button disabled={Boolean(startBlocked)} onClick={() => setState("running")}>{startLabel}</Button>}
      {state === "ready" && startBlocked && <span className="text-xs text-amber-400">{startBlocked}</span>}
      {state === "running" && (
        <>
          <Button variant="secondary" onClick={() => setState("paused")}>Pause</Button>
          <Button variant="secondary" onClick={() => setState("complete")}>Record completion</Button>
        </>
      )}
      {state === "paused" && (
        <>
          <Button onClick={() => setState("running")}>Resume</Button>
          <Button variant="secondary" onClick={() => setState("complete")}>Record completion</Button>
        </>
      )}
      {state === "complete" && !hideContinue && <Button onClick={onContinue}>{continueLabel} →</Button>}
      {(state === "running" || state === "paused") && (
        <Button variant="danger" onClick={() => setState("fault")}>Emergency stop</Button>
      )}
      {state === "fault" && <Status tone="red">Fault — controller reset required</Status>}
      {state === "fault" && onReset && <Button variant="secondary" onClick={onReset}>Reset controller</Button>}
    </div>
    {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </>
  );
}

const PUMP_INFO: Record<PumpName, { label: string; short: string; tank: string }> = {
  catalyst: { label: "Pump A · NaOH/KOH + methanol", short: "pump A", tank: "A" },
  acid: { label: "Pump B · H₂SO₄ + methanol", short: "pump B", tank: "B" },
};

type PumpView = { phase: PumpPhase; deliveredG: number; faultReason: string | null; byTime: boolean };

/** Before a reaction stage: acetone poured by hand (weighed by the reactor load cell), then the
 * premixed dose loaded by pump A or B. The pump stops when the reactor has gained the dose weight. */
function DosingPanel({
  pump,
  premixParts,
  mixingNote,
  targetG,
  premixMl,
  run,
  completedG,
  manual,
  setManual,
  onLoad,
  onStop,
  onSkip,
  locked,
  acetone,
  reactorG,
  live,
}: {
  pump: PumpName;
  premixParts: string[];
  mixingNote: string;
  targetG: number;
  premixMl: number;
  /** The pump run for this dose, when one is running or just ended. */
  run: PumpView | null;
  completedG: number;
  manual: boolean;
  setManual: (value: boolean) => void;
  onLoad: () => void;
  onStop: () => void;
  onSkip?: () => void;
  /** Why loading isn't possible now (e.g. the reactor is draining), or nothing. */
  locked?: string | null;
  acetone?: { ml: number; g: number; addedG: number; onDemoAdd?: () => void } | null;
  reactorG: number;
  live: boolean;
}) {
  const info = PUMP_INFO[pump];
  const pumping = run?.phase === "pumping";
  const deliveredG = completedG + (pumping ? run.deliveredG : 0);
  const loaded = deliveredG >= targetG - 1;
  const remainingG = Math.max(targetG - deliveredG, 0);
  const ended = run && (run.phase === "fault" || run.phase === "stopped") ? run : null;
  const number = acetone ? 2 : 1;
  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5" data-testid={`dosing-${pump}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="gv-label">Load the reactor</div>
          <p className="text-sm text-gray-300">Reactor load cell: <span className="font-mono text-white">{reactorG.toFixed(1)} g</span> <span className="text-xs text-gray-600">· {live ? "live" : "demonstration"}</span></p>
        </div>
        <Status tone={loaded || manual ? "green" : pumping ? "blue" : ended?.phase === "fault" ? "red" : "yellow"}>
          {loaded ? "Dose loaded" : manual ? "Added by hand" : pumping ? "Pumping" : ended?.phase === "fault" ? "Pump fault" : "Waiting"}
        </Status>
      </div>
      <div className={`mt-5 grid gap-4 ${acetone ? "lg:grid-cols-2" : ""}`}>
        {acetone && (
          <div className="rounded-xl border border-white/[0.07] p-4">
            <div className="text-sm font-semibold text-white">1. Acetone · poured by hand</div>
            <p className="mt-1 text-xs leading-5 text-gray-500">Pour {acetone.ml.toFixed(1)} mL ({acetone.g.toFixed(1)} g) of acetone through the inlet filter. The reactor load cell weighs it.</p>
            <div className="mt-3 flex items-baseline justify-between gap-3 text-sm">
              <span className="text-gray-400">Poured so far</span>
              <span className="font-mono text-white">{acetone.addedG.toFixed(1)} / {acetone.g.toFixed(1)} g</span>
            </div>
            <div className="mt-2"><Progress value={acetone.g > 0 ? (acetone.addedG / acetone.g) * 100 : 100} /></div>
            {acetone.onDemoAdd && acetone.addedG < acetone.g * 0.95 && (
              <Button variant="secondary" className="mt-3" onClick={acetone.onDemoAdd}>Pour acetone (demo)</Button>
            )}
          </div>
        )}
        <div className="rounded-xl border border-white/[0.07] p-4">
          <div className="text-sm font-semibold text-white">{number}. {info.label}</div>
          <p className="mt-1 text-xs leading-5 text-gray-500">
            Mix in tank {info.tank}: <span className="text-gray-300">{premixParts.join(" + ")}</span>. {mixingNote} Make about 10% extra in the same proportions so the line stays full; the pump stops at the dose weight.
          </p>
          <div className="mt-3 flex items-baseline justify-between gap-3 text-sm">
            <span className="text-gray-400">Delivered</span>
            <span className="font-mono text-white">{deliveredG.toFixed(1)} / {targetG.toFixed(1)} g</span>
          </div>
          <div className="mt-2"><Progress value={targetG > 0 ? (deliveredG / targetG) * 100 : 0} /></div>
          <p className="mt-2 text-xs text-gray-600">Dose {targetG.toFixed(1)} g · about {premixMl.toFixed(1)} mL{pumping && run.byTime ? " · no load cell reading: dosing by time" : ""}</p>
          {ended && !loaded && (
            <p className={`mt-2 text-xs ${ended.phase === "fault" ? "text-red-400" : "text-amber-400"}`}>
              Pump stopped at {deliveredG.toFixed(1)} g: {ended.faultReason}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!pumping && !loaded && !manual && (
              <Button disabled={Boolean(locked)} onClick={onLoad}>
                {completedG > 0 ? `Load the remaining ${remainingG.toFixed(1)} g` : `Load with ${info.short}`}
              </Button>
            )}
            {pumping && <Button variant="danger" onClick={onStop}>Stop pump</Button>}
            {pumping && onSkip && <Button variant="secondary" onClick={onSkip}>Skip (demo)</Button>}
            {locked && !pumping && !loaded && <span className="text-xs text-amber-400">{locked}</span>}
          </div>
          {!loaded && !pumping && (
            <label className="mt-3 flex items-center gap-2 text-xs text-gray-400">
              <input className="gv-checkbox" type="checkbox" checked={manual} onChange={(event) => setManual(event.target.checked)} />
              I added this dose by hand instead (pump not used)
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

type DrainView = { phase: DrainPhase; remainingSeconds: number; totalSeconds: number; waitingFor: string | null; faultReason: string | null };

const DRAIN_INFO: Record<DrainValve, { label: string; to: string }> = {
  reactor_outlet: { label: "Reactor outlet valve", to: "to the centrifuge" },
  centrifuge_outlet: { label: "Centrifuge outlet valve", to: "to the purification tank" },
};

/** An outlet valve that opens by itself after a stage, stays open for its drain time, then closes. */
function DrainPanel({
  valve,
  view,
  minutes,
  onAgain,
  onStop,
  onSkip,
}: {
  valve: DrainValve;
  view: DrainView | null;
  minutes: number;
  onAgain?: () => void;
  onStop?: () => void;
  onSkip?: () => void;
}) {
  const info = DRAIN_INFO[valve];
  const phase = view?.phase ?? "idle";
  const active = phase === "waiting" || phase === "draining";
  const tone = phase === "done" ? "green" : phase === "fault" ? "red" : active ? "blue" : "neutral";
  const text =
    minutes <= 0 && phase === "idle"
      ? `Opens by hand: the outlet time in Settings is 0. Move the liquid ${info.to} yourself.`
      : phase === "waiting"
        ? `Waiting for ${view?.waitingFor ?? "the centrifuge to stop"} before opening.`
        : phase === "draining"
          ? `Open: draining ${info.to} · ${formatTimer(view?.remainingSeconds ?? 0)} left.`
          : phase === "done"
            ? `Closed after ${formatMinutes(view?.totalSeconds ?? minutes * 60)}: the liquid went ${info.to}.`
            : phase === "stopped" || phase === "fault"
              ? `Closed early: ${view?.faultReason ?? "stopped"}.`
              : `Opens by itself for ${minutes} min.`;
  return (
    <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5" data-testid={`drain-${valve}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="gv-label">{info.label}</div>
          <p className="text-sm text-gray-300">{text}</p>
        </div>
        <Status tone={tone}>{phase === "waiting" ? "WAITING" : phase === "draining" ? "OPEN" : phase === "done" ? "CLOSED" : phase === "idle" ? "CLOSED" : "STOPPED"}</Status>
      </div>
      {phase === "draining" && view && view.totalSeconds > 0 && (
        <div className="mt-4"><Progress value={((view.totalSeconds - view.remainingSeconds) / view.totalSeconds) * 100} /></div>
      )}
      {(active || ((phase === "done" || phase === "stopped" || phase === "fault") && onAgain)) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {active && onStop && <Button variant="secondary" onClick={onStop}>Close now</Button>}
          {active && onSkip && <Button variant="secondary" onClick={onSkip}>Skip (demo)</Button>}
          {!active && onAgain && <Button variant="secondary" onClick={onAgain}>Open again ({minutes} min)</Button>}
        </div>
      )}
    </div>
  );
}

/** After an esterification stage: the FFA re-check with a new strip decides what comes next. */
function RecheckPanel({
  stage,
  value,
  setValue,
  aboveStrip,
  setAboveStrip,
  settings,
  next,
  catalyst,
  onAnotherStage,
  onContinue,
}: {
  stage: number;
  value: string;
  setValue: (value: string) => void;
  aboveStrip: boolean;
  setAboveStrip: (value: boolean) => void;
  settings: ChemistrySettings;
  next: { ffa: number; ester: EsterDose; trans: TransDose } | null;
  catalyst: "NaOH" | "KOH";
  onAnotherStage: () => void;
  onContinue: () => void;
}) {
  const error = aboveStrip ? "" : decimalError(value, { min: 0, max: settings.stripMaxFfa }, {
    empty: "Enter the re-check FFA.",
    max: `The strip reads up to ${settings.stripMaxFfa}%. Tick the darkest color instead.`,
  });
  const done = next !== null && next.ffa <= settings.ffaTarget;
  return (
    <div className="mt-6 rounded-xl border border-green-500/20 bg-green-500/[0.03] p-5" data-testid="ffa-recheck">
      <div className="gv-label">FFA re-check after stage {stage}</div>
      <p className="text-sm text-gray-300">Test a sample from the oil layer with a new strip. At or below {settings.ffaTarget}%, go on to transesterification; above it, run another esterification stage.</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <Field label="FFA after esterification" inputMode="decimal" value={aboveStrip ? String(settings.stripMaxFfa) : value} disabled={aboveStrip} onChange={(event) => setValue(event.target.value)} unit="%" aria-invalid={Boolean(error) && value !== ""} />
          {error && value !== "" && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>
        <label className="flex items-center gap-2 self-end pb-3 text-sm text-gray-300">
          <input className="gv-checkbox" type="checkbox" checked={aboveStrip} onChange={(event) => setAboveStrip(event.target.checked)} />
          Still the darkest color ({settings.stripMaxFfa}% or more)
        </label>
      </div>
      {next && !error && (
        done ? (
          <div className="mt-4 rounded-xl border border-green-500/20 bg-green-500/[0.05] p-4 text-sm text-green-400">
            FFA {next.ffa.toFixed(1)}% is at or below {settings.ffaTarget}%. Transesterification uses the exact amount: <b>{next.trans.catalystToWeighG.toFixed(2)} g {catalyst}</b> ({next.trans.catalystBaseG.toFixed(2)} g catalyst + {next.trans.neutralizationG.toFixed(2)} g to neutralize {next.ffa.toFixed(1)}% FFA).
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-4 text-sm text-amber-400">
            FFA is still {aboveStrip ? `${settings.stripMaxFfa}% or more` : `${next.ffa.toFixed(1)}%`}, above {settings.ffaTarget}%. Stage {stage + 1}: {next.ester.methanolMl.toFixed(1)} mL methanol (40:1) + {next.ester.sulfuricAcidMl.toFixed(2)} mL H₂SO₄, dosed for {next.ester.doseFfa.toFixed(1)}% FFA. No more acetone.
            {aboveStrip && <span className="mt-1 block text-xs">The oil may have more than {settings.designFfa}% FFA. Stage {stage + 1} is dosed for {settings.designFfa}% again.</span>}
            {stage >= 3 && <span className="mt-1 block text-xs">Several stages haven't brought the FFA down. Consider checking the strip, the reaction time, or using a different feedstock.</span>}
          </div>
        )
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        {done && <Button onClick={onContinue}>Continue to Transesterification →</Button>}
        {next && !error && !done && <Button onClick={onAnotherStage}>Prepare esterification stage {stage + 1} →</Button>}
      </div>
    </div>
  );
}

function ReactionStage({
  kind,
  state,
  setState,
  oilMass,
  oilVolume,
  catalyst,
  ratio,
  esterDose,
  transDose,
  transExact,
  esterStage = 1,
  voltage,
  time,
  stirring,
  batchId,
  onContinue,
  liveStage,
  connected,
  liveMock,
  onReset,
  error,
  preparation,
  footer,
  startBlocked,
  hideContinue,
}: {
  kind: "Esterification" | "Transesterification";
  state: StageState;
  setState: (state: StageState) => void;
  oilMass: number;
  oilVolume: number | null;
  catalyst: "NaOH" | "KOH";
  ratio: number;
  esterDose: EsterDose;
  transDose: TransDose;
  /** The catalyst amount is exact (after the FFA re-check, or without esterification). */
  transExact: boolean;
  esterStage?: number;
  voltage: number;
  time: number;
  stirring: number;
  batchId: string;
  onContinue: () => void;
  liveStage: StageStatus | null;
  connected: boolean;
  liveMock: boolean;
  onReset?: () => void;
  error?: string | null;
  /** Loading the reactor (shown before the stage starts). */
  preparation?: ReactNode;
  /** Shown under the controls: the FFA re-check, or the reactor outlet. */
  footer?: ReactNode;
  startBlocked?: string | null;
  hideContinue?: boolean;
}) {
  const isEsterification = kind === "Esterification";
  const totalSeconds = time * 60;
  const elapsedSeconds = liveStage
    ? liveStage.elapsedSeconds
    : (state === "ready" ? 0 : state === "complete" ? time : Math.min(42, time)) * 60;
  const remainingSeconds = liveStage ? liveStage.remainingSeconds : Math.max(totalSeconds - elapsedSeconds, 0);
  const showTime = (seconds: number) => (liveStage ? formatTimer(seconds) : `${Math.round(seconds / 60)} min`);
  const title = isEsterification && esterStage > 1 ? `Esterification · stage ${esterStage}` : kind;
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader
          eyebrow={`Batch ${batchId}`}
          title={title}
          description={
            isEsterification
              ? esterStage > 1
                ? "FFA was still above 1% after the last stage: another acid stage, dosed for the re-check reading."
                : "Acid pretreatment of high-FFA feedstock before transesterification. The dose is the same for every oil above 4% FFA."
              : "Base-catalyzed conversion of the prepared oil into biodiesel."
          }
        />
        <Status
          tone={
            state === "complete"
              ? "green"
              : state === "fault"
                ? "red"
                : state === "paused"
                  ? "yellow"
                  : "blue"
          }
        >
          {state.toUpperCase()}
        </Status>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5"><Metric label="Oil in this batch" value={`${oilMass.toFixed(1)} g`} sub={oilVolume === null ? "Volume unavailable" : `${oilVolume.toFixed(1)} mL · recorded at oil loading`} /></Card>
        <Card className="p-5">
          <Metric
            label="Methanol"
            value={`${(isEsterification ? esterDose.methanolMl : transDose.methanolMl).toFixed(1)} mL`}
            sub={isEsterification ? `${esterStage === 1 ? "20:1" : "40:1"} methanol to FFA · dose for ${esterDose.doseFfa.toFixed(1)}% FFA` : `${ratio}:1 molar ratio · calculated`}
          />
        </Card>
        {isEsterification ? (
          <Card className="p-5"><Metric label="Sulfuric acid (H₂SO₄)" value={`${esterDose.sulfuricAcidMl.toFixed(2)} mL`} sub="98% · 5% of the dose's FFA weight · mixed into the methanol" /></Card>
        ) : (
          <Card className="p-5"><Metric label={`${catalyst} to weigh`} value={`${transExact ? "" : "Up to "}${transDose.catalystToWeighG.toFixed(2)} g`} sub={`${transDose.catalystBaseG.toFixed(1)} g catalyst + ${transDose.neutralizationG.toFixed(2)} g to neutralize · ${transDose.purity}% purity${transExact ? " · exact" : ""}`} /></Card>
        )}
        <Card className="p-5">
          <Metric
            label="Acetone"
            value={isEsterification && esterStage > 1 ? "None" : transDose.acetoneMl === null ? "Unavailable" : `${(isEsterification ? esterDose.acetoneMl : transDose.acetoneMl).toFixed(1)} mL`}
            sub={isEsterification && esterStage > 1 ? "Still in the reactor from stage 1" : "Provisional 10% · poured by hand through the inlet"}
          />
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5"><Metric label="Voltage setting" value={`${voltage} V`} /></Card>
        <Card className="p-5"><Metric label="Reaction time" value={`${time} min`} /></Card>
        <Card className="p-5"><Metric label="Stirring speed" value={`${stirring} RPM`} /></Card>
        <Card className="p-5"><Metric label="Batch ID" value={batchId} /></Card>
      </div>

      {state === "ready" && preparation}

      <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <div className="gv-label">Live monitoring</div>
            <p className={`text-xs ${connected && !liveMock ? "text-green-400" : "text-amber-400"}`}>
              {connected ? (liveMock ? "Simulated by the Greenova backend (demo mode)" : "Live readings from the Raspberry Pi") : "Demonstration data — no hardware controller connected"}
            </p>
          </div>
          <Status tone={state === "complete" ? "green" : state === "fault" ? "red" : "neutral"}>
            {state}
          </Status>
        </div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-6">
          <Metric label="Elapsed" value={showTime(elapsedSeconds)} />
          <Metric label="Remaining" value={showTime(remainingSeconds)} />
          <Metric label="Actual voltage" value={liveStage ? (liveStage.liveVoltage == null ? "—" : `${liveStage.liveVoltage.toFixed(1)} V`) : state === "running" ? `${voltage} V` : "0 V"} />
          <Metric label="Current" value={liveStage ? (liveStage.liveCurrent == null ? "—" : `${liveStage.liveCurrent.toFixed(2)} A`) : state === "running" ? "1.8 A" : "0 A"} sub={liveStage ? undefined : "Demo"} />
          <Metric label="Temperature" value={liveStage ? (liveStage.liveTemperature == null ? "—" : `${liveStage.liveTemperature.toFixed(1)} °C`) : "27 °C"} sub={liveStage ? (liveStage.averageTemperature == null ? undefined : `Average ${liveStage.averageTemperature.toFixed(1)} °C`) : "Demo"} />
          <Metric label="Stirring" value={liveStage ? (liveStage.liveRpm == null ? "—" : `${liveStage.liveRpm} RPM`) : state === "running" ? `${stirring} RPM` : "0 RPM"} />
        </div>
        <div className="mt-5"><Progress value={(elapsedSeconds / totalSeconds) * 100} /></div>
        {liveStage?.faultReason && <p className="mt-4 text-sm text-red-400">Stopped: {liveStage.faultReason}</p>}
      </div>
      <StageControls
        state={state}
        setState={setState}
        startLabel={isEsterification && esterStage > 1 ? `Start esterification stage ${esterStage}` : `Start ${kind}`}
        onContinue={onContinue}
        continueLabel={isEsterification ? "Continue to Transesterification" : "Continue to Separation"}
        onReset={onReset}
        error={error}
        startBlocked={startBlocked}
        hideContinue={hideContinue}
      />
      {footer}
    </Card>
  );
}

type LocalPump = { key: string; pump: PumpName; base: number; targetG: number; deliveredG: number; phase: PumpPhase; faultReason: string | null };
type LocalDrain = { valve: DrainValve; phase: DrainPhase; remainingSeconds: number; totalSeconds: number };
type DoseLoad = { completedG: number; manual: boolean };

export default function NewBatch() {
  const [step, setStep] = useState(0);
  // Reactor load cell: the oil, then everything poured or pumped in (live, or the local demo).
  const [reactorG, setReactorG] = useState(0);
  // The oil weight recorded at "Confirm detected quantity"; the calculations use it from then on.
  const [confirmedOilG, setConfirmedOilG] = useState<number | null>(null);
  const oilMassG = confirmedOilG ?? reactorG;
  const [targetVolume, setTargetVolume] = useState("500");
  const [ffa, setFfa] = useState("");
  // The strip shows its darkest color: FFA is at least the strip's maximum (5%).
  const [ffaAboveStrip, setFfaAboveStrip] = useState(false);
  // Esterification stages and the FFA re-check after each one
  const [esterStage, setEsterStage] = useState(1);
  const [esterRecords, setEsterRecords] = useState<EsterStageRecord[]>([]);
  const [nextDoseFfa, setNextDoseFfa] = useState<number | null>(null);
  const [recheckValue, setRecheckValue] = useState("");
  const [recheckAbove, setRecheckAbove] = useState(false);
  const [finalFfa, setFinalFfa] = useState<number | null>(null);
  // Dosing pumps: what each dose ("Esterification 1", "Transesterification") has received
  const [loads, setLoads] = useState<Record<string, DoseLoad>>({});
  const pendingPump = useRef<{ key: string; base: number; startedAt: string | null } | null>(null);
  const [localPump, setLocalPump] = useState<LocalPump | null>(null);
  const [localDrain, setLocalDrain] = useState<LocalDrain | null>(null);
  // Reactor weight when each dose's step opened, to show the acetone poured since
  const [acetoneBase, setAcetoneBase] = useState<Record<string, number>>({});
  const transferSettings = useMemo(getTransferSettings, []);
  const [stirrerOn, setStirrerOn] = useState(false);
  const [stirrerRpm, setStirrerRpm] = useState<number | null>(null);
  const [ratio, setRatio] = useState(7);
  const [catalyst, setCatalyst] = useState<"NaOH" | "KOH">("NaOH");
  const [esterVoltage, setEsterVoltage] = useState("20");
  const [esterTime, setEsterTime] = useState("120");
  const [esterStirring, setEsterStirring] = useState("500");
  const [transVoltage, setTransVoltage] = useState("30");
  const [transTime, setTransTime] = useState("120");
  const [transStirring, setTransStirring] = useState("500");
  const [loadingConfirmed, setLoadingConfirmed] = useState(false);
  const [esterState, setEsterState] = useState<StageState>("ready");
  const [transState, setTransState] = useState<StageState>("ready");
  const [separationState, setSeparationState] = useState<StageState>("ready");
  const purificationSettings = useMemo(getPurificationSettings, []);
  const [purificationPhase, setPurificationPhase] = useState<PurificationPhase>("ready");
  const [targetTemperature, setTargetTemperature] = useState(String(purificationSettings.targetTemperature));
  const [liveTemperature, setLiveTemperature] = useState<number | null>(27);
  const [startingTemperature, setStartingTemperature] = useState(27);
  const [highestTemperature, setHighestTemperature] = useState(27);
  const [heatingTimeSeconds, setHeatingTimeSeconds] = useState(0);
  const [holdRemainingSeconds, setHoldRemainingSeconds] = useState(
    Math.round(purificationSettings.holdTimeMinutes * 60),
  );
  const [heaterOn, setHeaterOn] = useState(false);
  const [plannedFlowSeconds, setPlannedFlowSeconds] = useState<number | null>(null);
  const [expectedBiodieselMl, setExpectedBiodieselMl] = useState<number | null>(null);
  const [drainElapsedSeconds, setDrainElapsedSeconds] = useState(0);
  const [purificationWarning, setPurificationWarning] = useState<string | null>(null);
  const [purificationAutomatic, setPurificationAutomatic] = useState(true);
  const localPurification = useRef<LocalPurification | null>(null);
  const autoStarted = useRef(false);
  const [flowElapsedSeconds, setFlowElapsedSeconds] = useState(0);
  const [flowStableSeconds, setFlowStableSeconds] = useState(0);
  const [outputWeightG, setOutputWeightG] = useState(0);
  const [flowRateGPerMinute, setFlowRateGPerMinute] = useState(0);
  const [heaterConfirmed, setHeaterConfirmed] = useState(false); // only used without a level switch
  const [purificationStarted, setPurificationStarted] = useState(false);
  const [safetyStopReason, setSafetyStopReason] = useState<string | null>(null);
  const [safetyStopOccurred, setSafetyStopOccurred] = useState(false);
  const [saved, setSaved] = useState(false);
  const { live, backend, mock } = useLiveData();
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedBatch, setSavedBatch] = useState<BatchRecord | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [batchId, setBatchId] = useState(() => `B-${new Date().getFullYear()}-${String(Date.now()).slice(-3)}`);

  // Batch ID from the backend's naming format (local ID when offline).
  useEffect(() => {
    let cancelled = false;
    getNextBatchId().then((id) => { if (!cancelled) setBatchId(id); }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const chemistrySettings = useMemo(getChemistrySettings, []);

  /** Shows the local demonstration state on the screen. */
  function showLocalPurification(sim: LocalPurification) {
    setPurificationPhase(sim.phase);
    const stirring = (sim.phase === "heating" || sim.phase === "hold") && transferSettings.stirringSpeed > 0;
    setStirrerOn(stirring);
    setStirrerRpm(stirring ? transferSettings.stirringSpeed : 0);
    setLiveTemperature(sim.temperature);
    setHighestTemperature(sim.highest);
    setHeaterOn(sim.heaterOn);
    setHeatingTimeSeconds(sim.heatingSeconds);
    setHoldRemainingSeconds(sim.holdRemaining);
    setPlannedFlowSeconds(sim.plannedFlow);
    setFlowElapsedSeconds(sim.flowElapsed);
    setDrainElapsedSeconds(sim.drainElapsed);
    setFlowStableSeconds(sim.stableSeconds);
    setOutputWeightG(sim.outputG);
    setFlowRateGPerMinute(sim.rateGPerMinute);
    setPurificationWarning(sim.warning);
    if (sim.stopReason) {
      setSafetyStopReason(sim.stopReason);
      setSafetyStopOccurred(true);
    }
  }

  // No backend: run the automatic purification as a local demonstration, one step per second.
  useEffect(() => {
    if (backend || !PURIFYING.includes(purificationPhase)) return;
    const timer = window.setInterval(() => {
      const sim = localPurification.current;
      if (!sim) return;
      stepLocalPurification(sim, purificationSettings, Number(targetTemperature));
      showLocalPurification({ ...sim });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, purificationPhase, purificationSettings, targetTemperature]);

  // Backend connected: show its live readings and the state of its stages.
  useEffect(() => {
    if (!backend || !live) return;
    if (live.sensors.oilMassG !== null) setReactorG(live.sensors.oilMassG);
    const stage = live.stage;
    if (stage.stage && stage.batchId === batchId) {
      if (stage.stage === "Esterification") setEsterState(stage.state);
      else if (stage.stage === "Transesterification") setTransState(stage.state);
      else setSeparationState(stage.state);
    }
    const p = live.purification;
    if (p.phase === "ready" || p.batchId !== batchId) {
      setLiveTemperature(live.sensors.temperature);
      return;
    }
    setPurificationPhase(p.phase);
    setPurificationStarted(true);
    setLiveTemperature(p.liveTemperature ?? live.sensors.temperature);
    if (p.startingTemperature !== null) setStartingTemperature(p.startingTemperature);
    if (p.highestTemperature !== null) setHighestTemperature(p.highestTemperature);
    setHeatingTimeSeconds(p.heatingTimeSeconds);
    setHoldRemainingSeconds(p.holdRemainingSeconds);
    setHeaterOn(p.heaterOn);
    if (p.targetTemperature !== null) setTargetTemperature(String(p.targetTemperature));
    setPlannedFlowSeconds(p.plannedFlowSeconds);
    setExpectedBiodieselMl(p.expectedBiodieselMl);
    setDrainElapsedSeconds(p.drainElapsedSeconds);
    setPurificationWarning(p.warning);
    setPurificationAutomatic(p.automatic);
    setFlowElapsedSeconds(p.flowElapsedSeconds);
    setFlowStableSeconds(p.flowStableSeconds);
    setOutputWeightG(p.outputWeightG ?? 0);
    setFlowRateGPerMinute(p.flowRateGPerMinute ?? 0);
    setSafetyStopReason(p.safetyStopReason);
    setSafetyStopOccurred(p.safetyStopOccurred);
    setStirrerOn(p.stirrerOn);
    setStirrerRpm(p.stirrerRpm);
  }, [backend, live, batchId]);

  // A pump run on the Pi has ended: add what it delivered to its dose.
  useEffect(() => {
    if (!backend || !live) return;
    const p = live.pump;
    const pending = pendingPump.current;
    if (!pending || p.startedAt !== pending.startedAt) return;
    if (p.phase === "done" || p.phase === "fault" || p.phase === "stopped") {
      pendingPump.current = null;
      setLoads((current) => ({
        ...current,
        [pending.key]: { completedG: pending.base + p.deliveredG, manual: current[pending.key]?.manual ?? false },
      }));
    }
  }, [backend, live]);

  // Local demonstration of a pump: the dose arrives in about 5 seconds.
  useEffect(() => {
    if (backend || !localPump || localPump.phase !== "pumping") return;
    const timer = window.setTimeout(() => {
      const stepG = Math.min(localPump.targetG / 5, localPump.targetG - localPump.deliveredG);
      const delivered = localPump.deliveredG + stepG;
      setReactorG((grams) => grams + stepG);
      if (delivered >= localPump.targetG - 0.01) {
        setLocalPump({ ...localPump, deliveredG: localPump.targetG, phase: "done" });
        setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.targetG, manual: false } }));
      } else {
        setLocalPump({ ...localPump, deliveredG: delivered });
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [backend, localPump]);

  // Local demonstration of an outlet valve: open for its drain time, one step per second.
  useEffect(() => {
    if (backend || !localDrain || localDrain.phase !== "draining") return;
    const timer = window.setTimeout(() => {
      const remaining = Math.max(localDrain.remainingSeconds - 1, 0);
      if (remaining === 0 && localDrain.valve === "reactor_outlet") setReactorG(0);
      setLocalDrain({ ...localDrain, remainingSeconds: remaining, phase: remaining === 0 ? "done" : "draining" });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [backend, localDrain]);

  const oilVolumeMl =
    PROCESS_CONFIG.oil.densityGPerMl > 0
      ? oilMassG / PROCESS_CONFIG.oil.densityGPerMl
      : null;
  const targetError = decimalError(
    targetVolume,
    {
      min: PROCESS_CONFIG.oil.minimumVolumeMl,
      max: PROCESS_CONFIG.oil.maximumVolumeMl,
    },
    {
      min: "Minimum oil volume is 100 mL.",
      max: "Maximum supported oil volume is 1000 mL.",
    },
  );
  const ffaError = ffaAboveStrip ? "" : decimalError(ffa, { min: 0, max: 100 }, { empty: "Enter a valid FFA percentage." });
  // Above the strip's range the batch is recorded at the strip's maximum (5%), marked "≥".
  const ffaNumber = ffaAboveStrip ? chemistrySettings.stripMaxFfa : Number(ffa);
  const requiresEsterification =
    !ffaError && ffaNumber > PROCESS_CONFIG.ffaThreshold;
  const measuredOilError =
    oilMassG <= 0 || oilVolumeMl === null
      ? "Load-cell reading is unavailable."
      : oilVolumeMl < PROCESS_CONFIG.oil.minimumVolumeMl
        ? "Minimum oil volume is 100 mL."
        : oilVolumeMl > PROCESS_CONFIG.oil.maximumVolumeMl
          ? "Maximum supported oil volume is 1000 mL."
          : "";
  const esterErrors = [
    decimalError(esterVoltage, PROCESS_CONFIG.esterification.voltage),
    decimalError(esterTime, PROCESS_CONFIG.esterification.time),
    decimalError(esterStirring, PROCESS_CONFIG.esterification.stirring),
  ];
  const transErrors = [
    decimalError(transVoltage, PROCESS_CONFIG.transesterification.voltage),
    decimalError(transTime, PROCESS_CONFIG.transesterification.time),
    decimalError(transStirring, PROCESS_CONFIG.transesterification.stirring),
  ];
  const parametersValid =
    !targetError &&
    !ffaError &&
    !measuredOilError &&
    !transErrors.some(Boolean) &&
    (!requiresEsterification || !esterErrors.some(Boolean));
  const calculatorValues = calculateQuantityCards(
    oilMassG,
    oilVolumeMl,
    ffaNumber,
    ratio,
    catalyst,
    chemistrySettings,
  );
  const calculatorReady = oilMassG > 0 && !ffaError;

  // ----- esterification stages and the FFA re-check -----
  const esterDoseNow = esterificationDose(oilMassG, oilVolumeMl, esterStage === 1 ? ffaNumber : nextDoseFfa ?? ffaNumber, esterStage, chemistrySettings);
  const recheckError = recheckAbove ? "" : decimalError(recheckValue, { min: 0, max: chemistrySettings.stripMaxFfa });
  const recheckFfa = recheckAbove ? chemistrySettings.stripMaxFfa : Number(recheckValue);
  const recheckNext = recheckError
    ? null
    : {
        ffa: recheckFfa,
        ester: esterificationDose(oilMassG, oilVolumeMl, recheckAbove ? chemistrySettings.designFfa : recheckFfa, esterStage + 1, chemistrySettings),
        trans: transesterificationDose(oilMassG, oilVolumeMl, recheckFfa, ratio, catalyst, chemistrySettings),
      };
  // Transesterification neutralizes the last re-check reading (exact), or the starting FFA.
  const transAcidPct = requiresEsterification ? finalFfa ?? chemistrySettings.ffaTarget : ffaNumber;
  const transDoseNow = transesterificationDose(oilMassG, oilVolumeMl, transAcidPct, ratio, catalyst, chemistrySettings);
  const transExact = !requiresEsterification || finalFfa !== null;
  const esterStagesRun = esterRecords.length || (requiresEsterification ? 1 : 0);
  const esterMethanolTotal = esterRecords.length ? esterRecords.reduce((sum, record) => sum + record.methanolMl, 0) : requiresEsterification ? calculatorValues.esterificationMethanolMl : 0;
  const acetoneTotalMl =
    (requiresEsterification ? esterRecords.find((record) => record.stage === 1)?.acetoneMl ?? calculatorValues.acetoneMl ?? 0 : 0) +
    (transDoseNow.acetoneMl ?? 0);
  const esterAcidTotal = esterRecords.length ? esterRecords.reduce((sum, record) => sum + record.sulfuricAcidMl, 0) : requiresEsterification ? calculatorValues.sulfuricAcidMl : 0;
  useEffect(() => {
    if (ffaError) return;
    let cancelled = false;
    // Best parameters for this FFA range, from the Raspberry Pi's batch records (local records offline).
    getRecommendedParametersForFfa(ffaNumber)
      .then((recommendation) => {
        if (cancelled || !recommendation) return;
        if (recommendation.esterificationVoltage != null) {
          setEsterVoltage(String(recommendation.esterificationVoltage));
        }
        if (recommendation.esterificationTime != null) {
          setEsterTime(String(recommendation.esterificationTime));
        }
        if (recommendation.esterificationStirring != null) {
          setEsterStirring(String(recommendation.esterificationStirring));
        }
        setTransVoltage(String(recommendation.transesterificationVoltage));
        setTransTime(String(recommendation.transesterificationTime));
        setTransStirring(String(recommendation.transesterificationStirring));
        setRatio(recommendation.methanolRatio);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ffaError, ffaNumber]);
  function unconfirmOil() {
    setLoadingConfirmed(false);
    setConfirmedOilG(null);
  }

  const targetReached =
    !targetError &&
    oilVolumeMl !== null &&
    Math.abs(oilVolumeMl - Number(targetVolume)) <= Math.max(Number(targetVolume) * 0.02, 5);
  const loadingStatus =
    oilMassG <= 0
      ? "Waiting for oil"
      : measuredOilError
        ? "Invalid quantity"
        : targetReached
          ? "Target quantity reached"
          : "Oil detected";
  const systemTiles: Array<{
    label: string;
    value: string;
    secondary?: string;
    state?: DeviceState;
  }> = [
    { label: "Power Supply", value: "Ready", secondary: "Output off · 0–30 V DC" },
    { label: "Electrodes", value: "Copper tube – stainless steel", secondary: "Connected" },
    { label: "Stirrer", value: "Ready" },
    { label: "Temperature Sensor", value: "Online", secondary: "27 °C · demonstration reading" },
    { label: "Reactor Load Cell", value: "Online", secondary: `${reactorG.toFixed(1)} g in the reactor · demonstration mode` },
    {
      label: "Oil Input",
      value: reactorG > 0 ? `${reactorG.toFixed(1)} g` : "No oil detected",
      secondary: "Pour the oil through the inlet filter",
      state: "ready",
    },
    { label: "Dosing Pumps", value: "Ready", secondary: "A: NaOH/KOH + methanol · B: H₂SO₄ + methanol" },
    { label: "Outlet Valves", value: "All closed", secondary: "Reactor, centrifuge and purification outlets" },
    { label: "Output Load Cell", value: "Online", secondary: "0.0 g in the biodiesel container" },
  ];
  const tiles = systemStatus?.tiles ?? systemTiles;
  const fault = tiles.find((tile) => tile.state === "fault");
  const checking = tiles.find((tile) => tile.state === "checking");
  const systemReady = !fault && !checking;
  const steps = useMemo(
    () => [
      "Before You Start",
      "Volume & Parameters",
      "Oil Loading",
      ...(requiresEsterification ? ["Esterification"] : []),
      "Transesterification",
      "Separation",
      "Purification",
      "Process Complete",
    ],
    [requiresEsterification],
  );
  const currentStage = steps[step];
  const next = () => setStep((current) => Math.min(steps.length - 1, current + 1));

  useEffect(() => {
    if (!backend) {
      setSystemStatus(null);
      return;
    }
    if (currentStage !== "Before You Start") return;
    let stopped = false;
    const load = () => getSystemStatus().then((status) => { if (!stopped) setSystemStatus(status); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [backend, currentStage]);

  const liveStageFor = (kind: StageName) =>
    backend && live && live.stage.stage === kind && live.stage.batchId === batchId ? live.stage : null;
  const liveSeparation = liveStageFor("Separation");
  const realHardware = backend && !mock;

  async function loadDemoReading() {
    unconfirmOil();
    setActionError(null);
    if (backend) {
      try {
        const sensors = await loadDemoOil(Number(targetVolume || 0));
        if (sensors.oilMassG !== null) setReactorG(sensors.oilMassG);
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    setReactorG(Number(targetVolume || 0) * PROCESS_CONFIG.oil.densityGPerMl);
  }

  // ----- dosing pumps -----
  const doseKey = currentStage === "Esterification" ? `Esterification ${esterStage}` : currentStage === "Transesterification" ? "Transesterification" : null;

  function pumpRunFor(key: string): PumpView | null {
    if (backend) {
      const p = live?.pump;
      if (!p || p.phase === "idle" || p.batchId !== batchId || p.stage !== key) return null;
      return { phase: p.phase, deliveredG: p.deliveredG, faultReason: p.faultReason, byTime: p.byTime };
    }
    if (!localPump || localPump.key !== key) return null;
    return { phase: localPump.phase, deliveredG: localPump.deliveredG, faultReason: localPump.faultReason, byTime: false };
  }

  const pumpRunning = backend ? live?.pump.phase === "pumping" : localPump?.phase === "pumping";

  function doseLoaded(key: string, targetG: number) {
    const record = loads[key];
    return Boolean(record && (record.manual || record.completedG >= targetG - 1));
  }

  /** "Load": the pump adds the dose (or what's left of it) and stops at its weight. */
  async function loadDose(key: string, pump: PumpName, targetG: number, premixMl: number) {
    setActionError(null);
    const base = loads[key]?.completedG ?? 0;
    const remainingG = targetG - base;
    if (remainingG <= 0.5) return;
    const volumeMl = (premixMl * remainingG) / targetG;
    if (backend) {
      try {
        const state = await startPump({
          pump,
          targetG: Number(remainingG.toFixed(1)),
          volumeMl: Number(Math.max(volumeMl, 0.1).toFixed(1)),
          batchId,
          stage: key,
        });
        pendingPump.current = { key, base, startedAt: state.startedAt };
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    setLocalPump({ key, pump, base, targetG: remainingG, deliveredG: 0, phase: "pumping", faultReason: null });
  }

  async function stopPump() {
    if (backend) {
      pumpAction("stop").catch((error) => setActionError(errorText(error)));
      return;
    }
    if (localPump?.phase === "pumping") {
      setLocalPump({ ...localPump, phase: "stopped", faultReason: "stopped by operator" });
      setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.deliveredG, manual: false } }));
    }
  }

  function skipPump() {
    if (backend) {
      pumpAction("skip").catch((error) => setActionError(errorText(error)));
      return;
    }
    if (localPump?.phase === "pumping") {
      setReactorG((grams) => grams + localPump.targetG - localPump.deliveredG);
      setLocalPump({ ...localPump, deliveredG: localPump.targetG, phase: "done" });
      setLoads((current) => ({ ...current, [localPump.key]: { completedG: localPump.base + localPump.targetG, manual: false } }));
    }
  }

  function setManualDose(key: string, manual: boolean) {
    setLoads((current) => ({ ...current, [key]: { completedG: current[key]?.completedG ?? 0, manual } }));
  }

  /** Demo: acetone poured through the inlet lands on the reactor load cell. */
  async function pourDemoAcetone(grams: number) {
    setActionError(null);
    if (backend) {
      try {
        const sensors = await demoAdd(Number(grams.toFixed(1)));
        if (sensors.oilMassG !== null) setReactorG(sensors.oilMassG);
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    setReactorG((current) => current + grams);
  }

  // Remember the reactor weight when a dose's step opens: acetone poured since = the rise.
  useEffect(() => {
    if (!doseKey || acetoneBase[doseKey] !== undefined) return;
    setAcetoneBase((current) => ({ ...current, [doseKey]: reactorG }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doseKey]);

  function acetonePouredG(key: string) {
    const run = pumpRunFor(key);
    const pumped = (loads[key]?.completedG ?? 0) + (run?.phase === "pumping" ? run.deliveredG : 0);
    return Math.max(reactorG - (acetoneBase[key] ?? reactorG) - pumped, 0);
  }

  // ----- outlet valves -----
  function drainViewFor(valve: DrainValve): DrainView | null {
    if (backend) {
      const d = live?.drain;
      if (!d || d.valve !== valve || d.batchId !== batchId || d.phase === "idle") return null;
      return d;
    }
    if (!localDrain || localDrain.valve !== valve) return null;
    return { ...localDrain, waitingFor: null, faultReason: localDrain.phase === "stopped" ? "closed by operator" : null };
  }

  const drainMinutes = (valve: DrainValve) =>
    valve === "reactor_outlet" ? transferSettings.reactorDrainMinutes : transferSettings.centrifugeDrainMinutes;

  function draining(valve: DrainValve) {
    const view = drainViewFor(valve);
    return view !== null && (view.phase === "waiting" || view.phase === "draining");
  }

  function startLocalDrain(valve: DrainValve) {
    const seconds = Math.round(drainMinutes(valve) * 60);
    if (seconds <= 0) return;
    setLocalDrain({ valve, phase: "draining", remainingSeconds: seconds, totalSeconds: seconds });
  }

  async function openDrainAgain(valve: DrainValve) {
    setActionError(null);
    if (backend) {
      try {
        await startDrain(valve, batchId);
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    startLocalDrain(valve);
  }

  function closeDrain() {
    if (backend) {
      drainAction("stop").catch((error) => setActionError(errorText(error)));
      return;
    }
    if (localDrain) setLocalDrain({ ...localDrain, phase: "stopped" });
  }

  function skipDrain() {
    if (backend) {
      drainAction("skip").catch((error) => setActionError(errorText(error)));
      return;
    }
    if (localDrain) {
      if (localDrain.valve === "reactor_outlet") setReactorG(0);
      setLocalDrain({ ...localDrain, remainingSeconds: 0, phase: "done" });
    }
  }

  // ----- FFA re-check after an esterification stage -----
  function recordEsterStage(ffaAfter: number) {
    const record: EsterStageRecord = {
      stage: esterStage,
      ffaBefore: esterStage === 1 ? ffaNumber : esterRecords[esterRecords.length - 1]?.ffaAfter ?? ffaNumber,
      ffaAfter,
      doseFfa: esterDoseNow.doseFfa,
      methanolMl: Number(esterDoseNow.methanolMl.toFixed(2)),
      sulfuricAcidMl: Number(esterDoseNow.sulfuricAcidMl.toFixed(3)),
      acetoneMl: Number(esterDoseNow.acetoneMl.toFixed(1)),
    };
    setEsterRecords((current) => [...current.filter((item) => item.stage !== esterStage), record]);
  }

  async function prepareNextEsterStage() {
    if (!recheckNext) return;
    setActionError(null);
    recordEsterStage(recheckNext.ffa);
    if (backend) {
      try {
        await stageAction("reset");
      } catch (error) {
        setActionError(errorText(error));
        return;
      }
    }
    setNextDoseFfa(recheckNext.ester.doseFfa);
    setEsterStage((current) => current + 1);
    setRecheckValue("");
    setRecheckAbove(false);
    setEsterState("ready");
  }

  function finishEsterification() {
    if (!recheckNext) return;
    recordEsterStage(recheckNext.ffa);
    setFinalFfa(recheckNext.ffa);
    next();
  }

  /** Stage buttons: the backend runs the stage when it's connected; otherwise the local demo. */
  async function controlStage(kind: StageName, nextState: StageState, current: StageState, setLocal: (state: StageState) => void) {
    setActionError(null);
    if (!backend) {
      setLocal(nextState);
      // the outlet valves open by themselves after these stages (the Pi does this itself)
      if (nextState === "complete" && kind === "Transesterification") startLocalDrain("reactor_outlet");
      if (nextState === "complete" && kind === "Separation") startLocalDrain("centrifuge_outlet");
      return;
    }
    try {
      let result: StageStatus;
      if (nextState === "running" && current === "ready") {
        result = await startStage(
          kind === "Separation"
            ? { stage: kind, batchId, oilMassG }
            : {
                stage: kind,
                batchId,
                voltage: Number(kind === "Esterification" ? esterVoltage : transVoltage),
                time: Number(kind === "Esterification" ? esterTime : transTime),
                stirring: Number(kind === "Esterification" ? esterStirring : transStirring),
                oilMassG,
              },
        );
      } else if (nextState === "running") {
        result = await stageAction("resume");
      } else if (nextState === "paused") {
        result = await stageAction("pause");
      } else if (nextState === "complete") {
        result = await stageAction("complete");
      } else if (nextState === "fault") {
        result = await stageAction("emergency-stop");
      } else {
        result = await stageAction("reset");
      }
      setLocal(result.state);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  async function resetStage(setLocal: (state: StageState) => void) {
    setActionError(null);
    if (!backend) {
      setLocal("ready");
      return;
    }
    try {
      setLocal((await stageAction("reset")).state);
    } catch (error) {
      setActionError(errorText(error));
    }
  }

  /** Starts purification now. Normally it starts by itself: the backend starts it after separation
   * when the level switch detects biodiesel, and the local demonstration starts it on this screen. */
  async function startPurificationNow(automatic: boolean) {
    setActionError(null);
    setPurificationWarning(null);
    if (backend) {
      try {
        const state = await startPurification({
          heaterSubmerged: heaterConfirmed,
          batchId,
          oilVolumeMl: oilVolumeMl ?? undefined,
        });
        setPurificationStarted(true);
        setPurificationPhase(state.phase);
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    const temperature = liveTemperature ?? 27;
    const planned = plannedFlowSecondsFor(oilVolumeMl, purificationSettings);
    const sim: LocalPurification = {
      phase: "heating",
      temperature,
      highest: temperature,
      heaterOn: true,
      heatingSeconds: 0,
      holdRemaining: Math.round(purificationSettings.holdTimeMinutes * 60),
      plannedFlow: planned,
      flowElapsed: 0,
      drainElapsed: 0,
      stableSeconds: 0,
      outputG: 0,
      tankG: oilMassG * 0.85,
      rateGPerMinute: 0,
      expectedG: (oilVolumeMl ?? 0) * 0.88,
      warning: null,
      stopReason: null,
    };
    localPurification.current = sim;
    setExpectedBiodieselMl(oilVolumeMl);
    setPurificationAutomatic(automatic);
    setStartingTemperature(temperature);
    setPurificationStarted(true);
    showLocalPurification({ ...sim });
  }

  /** "Skip timer (demo)": finishes the current phase now. */
  function skipPurificationPhase() {
    if (backend) {
      purificationAction("skip").catch((error) => setActionError(errorText(error)));
      return;
    }
    const sim = localPurification.current;
    if (!sim) return;
    if (sim.phase === "heating") sim.temperature = Number(targetTemperature);
    else if (sim.phase === "hold") sim.holdRemaining = 1;
    else if (sim.phase === "flow") {
      sim.outputG = Number((sim.outputG + sim.tankG).toFixed(1));
      sim.tankG = 0;
      sim.flowElapsed = Math.max(sim.plannedFlow - 1, 0);
    } else if (sim.phase === "drain") sim.stableSeconds = 60;
    showLocalPurification({ ...sim });
  }

  async function stopPurification() {
    setActionError(null);
    if (backend) {
      try {
        await purificationAction("abort");
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    const sim = localPurification.current;
    if (sim) {
      sim.phase = "fault";
      sim.heaterOn = false;
      sim.stopReason = "stopped by operator";
      showLocalPurification({ ...sim });
    }
  }

  async function acknowledgeSafetyStop() {
    setActionError(null);
    if (backend) {
      try {
        await purificationAction("acknowledge");
      } catch (error) {
        setActionError(errorText(error));
        return;
      }
    }
    localPurification.current = null;
    setSafetyStopReason(null);
    setPurificationPhase("ready");
    setPurificationStarted(false);
    setHeaterConfirmed(false);
  }

  // Separation complete: go on to Purification by itself.
  useEffect(() => {
    if (currentStage !== "Separation" || separationState !== "complete") return;
    const timer = window.setTimeout(next, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStage, separationState]);

  // Local demonstration: purification starts by itself on the Purification screen (once per batch).
  // With the backend, the Raspberry Pi starts it after separation, when the level switch detects biodiesel.
  useEffect(() => {
    if (backend || currentStage !== "Purification" || autoStarted.current || purificationPhase !== "ready") return;
    if (localDrain && localDrain.valve === "centrifuge_outlet" && localDrain.phase === "draining") return;   // biodiesel still on its way
    autoStarted.current = true;
    startPurificationNow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, currentStage, purificationPhase, localDrain]);

  const levelSwitch = backend && live ? live.sensors.heaterSubmerged : null;
  const autoStartPending = backend && live !== null && live.purificationAutoStart === batchId;
  const centrifugeDraining = draining("centrifuge_outlet");
  const showManualStart =
    purificationPhase === "ready" && !safetyStopReason && !centrifugeDraining && (!backend || !autoStartPending || levelSwitch === null);
  const shownPlannedFlowSeconds = plannedFlowSeconds ?? plannedFlowSecondsFor(oilVolumeMl, purificationSettings);
  const shownBiodieselMl = expectedBiodieselMl ?? oilVolumeMl;

  async function completeBatch() {
    if (!saved) {
      setActionError(null);
      const totalReactionTime =
        Number(transTime) + (requiresEsterification ? Number(esterTime) * esterStagesRun : 0);
      const oilVolume = Number((oilVolumeMl ?? 0).toFixed(1));
      // Offline the website works out the yield itself from the output load cell; the Pi does it on its own.
      const localOutputMl = !backend && outputWeightG > 0 ? Number((outputWeightG / 0.88).toFixed(1)) : undefined;
      let result: BatchRecord;
      try {
        result = await saveCompletedBatch({
          id: batchId,
          date: new Date().toISOString().slice(0, 10),
          oilVolume,
          yield: localOutputMl && oilVolume ? Number(((localOutputMl / oilVolume) * 100).toFixed(1)) : 0,
          biodieselOutputMl: localOutputMl,
          duration: totalReactionTime + PROCESS_CONFIG.separation.timeMinutes,
          energy: 0,
          status: "Completed",
          labResult: "Pending",
          ffa: ffaNumber,
          ffaAboveStrip,
          oilMassG: Number(oilMassG.toFixed(1)),
          catalystToWeighG: Number(transDoseNow.catalystToWeighG.toFixed(3)),
          esterificationStages: esterRecords,
          esterificationRun: requiresEsterification,
          temperature: 27,
          reactionTime: Number(transTime),
          stirringSpeed: Number(transStirring),
          voltage: Number(transVoltage),
          methanolRatio: ratio,
          esterificationVoltage: requiresEsterification ? Number(esterVoltage) : undefined,
          esterificationTime: requiresEsterification ? Number(esterTime) : undefined,
          esterificationStirring: requiresEsterification ? Number(esterStirring) : undefined,
          catalystType: catalyst,
          purification: {
            targetTemperature: Number(targetTemperature),
            highestTemperature,
            heatingTimeSeconds,
            holdTimeSeconds:
              Math.round(purificationSettings.holdTimeMinutes * 60) - holdRemainingSeconds,
            flowTimeSeconds: flowElapsedSeconds,
            drainTimeSeconds: drainElapsedSeconds,
            expectedBiodieselMl: shownBiodieselMl,
            plannedFlowSeconds: shownPlannedFlowSeconds,
            automatic: purificationAutomatic,
            warning: purificationWarning,
            safetyStopOccurred,
            stirringSpeed: transferSettings.stirringSpeed,
            outputWeightG: outputWeightG || null,
          },
        });
      } catch (error) {
        setActionError(errorText(error));
        return;
      }
      setSavedBatch(result);
      setSaved(true);
    }
    next();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">Batch {batchId}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">Process</Heading>
          <p className="mt-2 text-sm text-gray-500">Guided electrochemical biodiesel production workflow.</p>
        </div>
        <Status tone={currentStage === "Process Complete" ? "green" : "blue"}>
          {currentStage === "Process Complete" ? "Completed" : currentStage}
        </Status>
      </div>
      <Stepper steps={steps} step={step} />

      {actionError && (
        <div role="alert" className="flex items-start justify-between gap-4 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-4 text-sm text-red-300">
          <span>{actionError}</span>
          <button type="button" className="text-xs text-gray-400 hover:text-white" onClick={() => setActionError(null)}>Dismiss</button>
        </div>
      )}

      {currentStage === "Before You Start" && (
        <div className="space-y-6">
          <SectionHeader
            eyebrow="Process introduction"
            title="Before You Start"
            description="Greenova checks the system automatically. Review the safety guidance before preparing your batch."
          />
          <Card className="p-6 sm:p-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <Heading as="h2" className="text-lg font-semibold">System Status</Heading>
                <p className="mt-1 text-sm text-gray-500">Read-only prototype channels update automatically.</p>
              </div>
              <Status tone={realHardware ? "green" : "yellow"}>{backend ? (mock ? "Demonstration backend" : "Live hardware") : "Demonstration mode"}</Status>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((tile) => <ReadOnlyTile key={tile.label} {...tile} />)}
            </div>
            <div className={`mt-5 rounded-xl border p-5 ${systemReady ? "border-green-500/25 bg-green-500/[0.06]" : fault ? "border-red-500/25 bg-red-500/[0.05]" : "border-amber-400/25 bg-amber-400/[0.05]"}`}>
              <div className="flex items-start gap-3">
                <StateDot state={systemReady ? "ready" : fault ? "fault" : "checking"} />
                <div>
                  <div className={`font-display font-semibold ${systemReady ? "text-green-400" : fault ? "text-red-400" : "text-amber-400"}`}>
                    {systemReady ? "System Ready" : fault ? "System Fault / Not Ready" : "Checking system"}
                  </div>
                  <p className="mt-1 text-sm text-gray-400">Automatic safety monitoring must remain active throughout the process.</p>
                  <p className="mt-2 text-xs leading-5 text-gray-600">A Ready display does not energize the reactor. The controller must verify all required interlocks before power is enabled.</p>
                </div>
              </div>
            </div>
          </Card>

          <Card className="border-amber-400/15 p-6 sm:p-8">
            <Heading as="h2" className="text-lg font-semibold">Safety Guidance</Heading>
            <p className="mt-1 text-sm text-gray-500">Review the approved laboratory procedures before starting.</p>
            <div className="mt-6 grid gap-7 lg:grid-cols-3">
              {SAFETY_GROUPS.map((group) => (
                <div key={group.title}>
                  <div className="border-b border-amber-400/15 pb-3 text-xs font-semibold uppercase tracking-[0.12em] text-amber-400">{group.title}</div>
                  <div className="mt-4 space-y-4">
                    {group.items.map(([title, description]) => (
                      <div key={title} className="flex gap-3">
                        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber-400/25 text-[10px] font-bold text-amber-400">i</div>
                        <div>
                          <div className="text-sm font-medium text-gray-300">{title}</div>
                          <p className="mt-1 text-xs leading-5 text-gray-500">{description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link to="/dashboard" className="btn-ghost justify-center">Back to Dashboard</Link>
            <Button onClick={next}>Continue →</Button>
          </div>
        </div>
      )}

      {currentStage === "Volume & Parameters" && (
        <div className="space-y-6">
          <SectionHeader
            eyebrow="Operator setup"
            title="Volume & Parameters"
            description="Review the live oil measurement, enter the test-strip FFA result, and configure the validated operating parameters."
          />
          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6 sm:p-8">
              <Heading as="h2" className="text-lg font-semibold">1. Oil Input</Heading>
              <p className="mt-1 text-sm text-gray-500">Pour the oil through the inlet filter. The reactor load cell is authoritative for the actual oil mass.</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <ReadOnlyTile label="Live oil mass" value={`${oilMassG.toFixed(1)} g`} secondary={realHardware ? "Reactor load cell · live" : "Reactor load cell · demonstration channel"} state={oilMassG > 0 ? "ready" : "checking"} />
                <ReadOnlyTile label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} secondary={`Configured density: ${PROCESS_CONFIG.oil.densityGPerMl} g/mL · assumed`} state={oilMassG > 0 ? "ready" : "checking"} />
              </div>
              <div className="mt-5">
                <Field label="Target batch volume" inputMode="decimal" value={targetVolume} onChange={(event) => { setTargetVolume(event.target.value); unconfirmOil(); }} unit="mL" aria-invalid={Boolean(targetError)} />
                <p className={`mt-2 text-xs ${targetError ? "text-red-400" : "text-gray-600"}`}>{targetError || "Supported prototype capacity: 100–1,000 mL."}</p>
              </div>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                {!realHardware && <Button variant="secondary" disabled={Boolean(targetError)} onClick={loadDemoReading}>Load demonstration sensor reading</Button>}
                {realHardware ? <Status>Live load cell</Status> : <Status tone="yellow">Not live hardware</Status>}
              </div>
              {measuredOilError && <p className="mt-3 text-xs text-red-400">{measuredOilError}</p>}
            </Card>

            <Card className="p-6 sm:p-8">
              <Heading as="h2" className="text-lg font-semibold">2. FFA Measurement</Heading>
              <p className="mt-1 text-sm text-gray-500">Measure the feedstock using the FFA test strips, then enter the observed result. The strip reads up to {chemistrySettings.stripMaxFfa}%.</p>
              <div className="mt-6">
                <Field label="FFA Percentage" inputMode="decimal" value={ffaAboveStrip ? String(chemistrySettings.stripMaxFfa) : ffa} disabled={ffaAboveStrip} onChange={(event) => setFfa(event.target.value)} unit="%" aria-invalid={Boolean(ffaError)} />
                {ffaError && <p className="mt-2 text-xs text-red-400">{ffaError}</p>}
                {!ffaError && !ffaAboveStrip && ffaNumber > chemistrySettings.stripMaxFfa && (
                  <p className="mt-2 text-xs text-amber-400">The strip reads only up to {chemistrySettings.stripMaxFfa}%. If it shows its darkest color, tick the box below.</p>
                )}
                <label className="mt-4 flex items-center gap-2 text-sm text-gray-300">
                  <input className="gv-checkbox" type="checkbox" checked={ffaAboveStrip} onChange={(event) => setFfaAboveStrip(event.target.checked)} />
                  The strip shows its darkest color ({chemistrySettings.stripMaxFfa}% or more)
                </label>
              </div>
              {!ffaError && (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                  <div className="gv-label">Pathway decision · threshold {PROCESS_CONFIG.ffaThreshold.toFixed(1)}%</div>
                  <p className="text-sm text-gray-300">
                    {ffaAboveStrip
                      ? `FFA ${chemistrySettings.stripMaxFfa}% or more (recorded as ≥ ${chemistrySettings.stripMaxFfa}%). Esterification with the uniform dose for ${chemistrySettings.designFfa}% FFA, then an FFA re-check.`
                      : requiresEsterification
                        ? `Esterification required before transesterification: the uniform dose for ${chemistrySettings.designFfa}% FFA, then an FFA re-check.`
                        : "Proceed directly to transesterification."}
                  </p>
                </div>
              )}
            </Card>
          </div>

          <Card className="p-6 sm:p-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <Heading as="h2" className="text-lg font-semibold">3. Chemical Quantity Calculator</Heading>
                <p className="mt-1 text-sm text-gray-500">Calculated values are planning quantities, not actual dispensed amounts.</p>
              </div>
              <Status tone="neutral">Read only calculations</Status>
            </div>
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <SelectField label="Methanol-to-oil ratio" value={ratio} onChange={(event) => setRatio(Number(event.target.value))}>
                {[6, 7, 8, 9].map((value) => <option key={value} value={value}>{value}:1</option>)}
              </SelectField>
              <SelectField label="Base catalyst" value={catalyst} onChange={(event) => setCatalyst(event.target.value as "NaOH" | "KOH")}>
                <option value="NaOH">NaOH</option>
                <option value="KOH">KOH</option>
              </SelectField>
            </div>

            <div className="mt-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Heading as="h3" className="text-base font-semibold">Esterification</Heading>
                {calculatorReady && requiresEsterification && <Status tone="yellow">Uniform dose · {calculatorValues.doseFfa}% design FFA</Status>}
              </div>
              {calculatorReady && !requiresEsterification ? (
                <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-5 text-sm text-gray-500">
                  Esterification not needed — FFA is 4% or below.
                </div>
              ) : (
                <>
                  <div className="grid gap-4 md:grid-cols-3">
                    <ReadOnlyTile
                      label="Methanol"
                      value={calculatorReady ? `${calculatorValues.esterificationMethanolMl.toFixed(1)} mL` : "—"}
                      secondary={calculatorReady ? `20:1 methanol to FFA · dosed for ${calculatorValues.doseFfa}% FFA: ${calculatorValues.ffaMassG.toFixed(1)} g × 2.84` : undefined}
                    />
                    <ReadOnlyTile
                      label="Sulfuric acid 98%"
                      value={calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—"}
                      secondary={calculatorReady ? `5% of the dose's FFA weight · ${calculatorValues.ffaMassG.toFixed(1)} g × 0.027` : undefined}
                    />
                    <ReadOnlyTile
                      label="Acetone"
                      value={calculatorReady && calculatorValues.acetoneMl !== null ? `${calculatorValues.acetoneMl.toFixed(1)} mL` : "—"}
                      secondary={calculatorReady ? "Provisional 10% of oil volume" : undefined}
                    />
                  </div>
                  {calculatorReady && requiresEsterification && (
                    <p className="mt-3 text-xs leading-5 text-gray-500">
                      Every batch above {PROCESS_CONFIG.ffaThreshold}% FFA gets this dose, because the strip can't measure above {chemistrySettings.stripMaxFfa}%. It covers oil up to {chemistrySettings.designFfa}% FFA. Pump B loads it as one premix ({calculatorValues.esterificationPremixG.toFixed(1)} g). After the stage, an FFA re-check decides: at or below {chemistrySettings.ffaTarget}%, transesterification with the exact catalyst; above it, another stage dosed for the reading.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="mt-7 border-t border-white/[0.07] pt-7">
              <div className="mb-3 flex items-center justify-between gap-3">
                <Heading as="h3" className="text-base font-semibold">Transesterification</Heading>
                <span className="text-xs text-gray-600">
                  Oil molar mass: {chemistrySettings.oilMolarMass} g/mol
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <ReadOnlyTile
                  label="Methanol"
                  value={calculatorReady ? `${calculatorValues.transesterificationMethanolMl.toFixed(1)} mL` : "—"}
                  secondary={calculatorReady ? `${ratio}:1 molar ratio · ${oilMassG.toFixed(1)} g oil` : undefined}
                />
                <ReadOnlyTile
                  label={`${catalyst} to weigh`}
                  value={calculatorReady ? `${requiresEsterification ? "Up to " : ""}${calculatorValues.catalystToWeighG.toFixed(1)} g` : "—"}
                  secondary={
                    calculatorReady
                      ? requiresEsterification
                        ? `${calculatorValues.catalystBaseG.toFixed(1)} g catalyst + up to ${calculatorValues.neutralizationG.toFixed(1)} g to neutralize acid · final amount after the FFA re-check`
                        : `${calculatorValues.catalystBaseG.toFixed(1)} g catalyst + ${calculatorValues.neutralizationG.toFixed(1)} g to neutralize FFA · ${calculatorValues.purity}% purity · pump A premix ${calculatorValues.transesterificationPremixG.toFixed(1)} g`
                      : undefined
                  }
                />
                <ReadOnlyTile
                  label="Acetone"
                  value={calculatorReady && calculatorValues.acetoneMl !== null ? `${calculatorValues.acetoneMl.toFixed(1)} mL` : "—"}
                  secondary={calculatorReady ? "Provisional 10% of oil volume" : undefined}
                />
              </div>
            </div>
          </Card>

          <Card className="p-6 sm:p-8">
            <Heading as="h2" className="text-lg font-semibold">4. Reaction Parameters</Heading>
            <p className="mt-1 text-sm text-gray-500">Temperature is monitored live and is not an operator-configurable parameter.</p>
            <div className={`mt-6 grid gap-6 ${requiresEsterification ? "xl:grid-cols-2" : ""}`}>
              {requiresEsterification && (
                <div className="rounded-xl border border-white/[0.07] bg-gv-inset p-5">
                  <div className="flex items-center justify-between gap-3"><Heading as="h3" className="text-base font-semibold">Esterification Settings</Heading><Status tone="yellow">Pump B · acid + methanol</Status></div>
                  <div className="mt-5 grid gap-5 sm:grid-cols-3">
                    <ParameterField label="Voltage" value={esterVoltage} setValue={setEsterVoltage} unit="V" limits={PROCESS_CONFIG.esterification.voltage} />
                    <ParameterField label="Reaction time" value={esterTime} setValue={setEsterTime} unit="min" limits={PROCESS_CONFIG.esterification.time} />
                    <ParameterField label="Stirring speed" value={esterStirring} setValue={setEsterStirring} unit="RPM" limits={PROCESS_CONFIG.esterification.stirring} />
                  </div>
                  <p className="mt-4 text-xs text-amber-400">Sulfuric acid (98%): {calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—"}, mixed by hand into the methanol in tank B. Pump B loads the premix into the reactor.</p>
                </div>
              )}
              <div className="rounded-xl border border-green-500/15 bg-green-500/[0.025] p-5">
                <div className="flex items-center justify-between gap-3"><Heading as="h3" className="text-base font-semibold">Transesterification Settings</Heading><Status tone="green">Project defaults</Status></div>
                <div className="mt-5 grid gap-5 sm:grid-cols-3">
                  <ParameterField label="Voltage" value={transVoltage} setValue={setTransVoltage} unit="V" limits={PROCESS_CONFIG.transesterification.voltage} />
                  <ParameterField label="Reaction time" value={transTime} setValue={setTransTime} unit="min" limits={PROCESS_CONFIG.transesterification.time} />
                  <ParameterField label="Stirring speed" value={transStirring} setValue={setTransStirring} unit="RPM" limits={PROCESS_CONFIG.transesterification.stirring} />
                </div>
              </div>
            </div>
          </Card>
          <div className="flex justify-end"><Button disabled={!parametersValid} onClick={next}>Continue to Oil Loading →</Button></div>
        </div>
      )}

      {currentStage === "Oil Loading" && (
        <Card className="p-6 sm:p-8">
          <SectionHeader eyebrow="Manual stage" title="Oil Loading" description="Pour the oil through the inlet filter while the reactor load cell weighs it. Confirm to record the oil weight; the calculations use it from then on." />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label="Target oil volume" value={`${Number(targetVolume).toFixed(1)} mL`} /></Card>
            <Card className="p-5"><Metric label="Live measured mass" value={`${oilMassG.toFixed(1)} g`} sub={realHardware ? "Live load-cell data" : "Demonstration load-cell data"} /></Card>
            <Card className="p-5"><Metric label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} sub="Using configured assumed density" /></Card>
            <Card className="p-5"><Metric label="Loading status" value={loadingConfirmed ? "Quantity confirmed" : loadingStatus} accent={targetReached} /></Card>
          </div>
          <div className="mt-6 rounded-xl border border-white/[0.07] bg-gv-inset p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="gv-label">Load-cell status</div>
                <p className="text-sm text-gray-300">{targetReached ? "Required quantity detected within ±2% tolerance." : "Continue loading until the target quantity is detected."}</p>
              </div>
              <Status tone={targetReached ? "green" : measuredOilError ? "red" : "yellow"}>{loadingStatus}</Status>
            </div>
          </div>
          <div className="mt-7 flex flex-wrap gap-3">
            {!targetReached && !realHardware && <Button variant="secondary" onClick={loadDemoReading}>Simulate target reading</Button>}
            <Button disabled={!targetReached || loadingConfirmed} onClick={() => { setLoadingConfirmed(true); setConfirmedOilG(reactorG); }} variant={loadingConfirmed ? "secondary" : "primary"}>{loadingConfirmed ? "Quantity confirmed" : "Confirm detected quantity"}</Button>
            {loadingConfirmed && <Button onClick={next}>Continue to {requiresEsterification ? "Esterification" : "Transesterification"} →</Button>}
          </div>
          {loadingConfirmed && (
            <p className="mt-3 text-xs leading-5 text-gray-500">Oil recorded: {oilMassG.toFixed(1)} g. The load cell keeps weighing everything added from now on (acetone and the pumped doses).</p>
          )}
        </Card>
      )}

      {currentStage === "Esterification" && doseKey && (() => {
        const key = doseKey;
        const run = pumpRunFor(key);
        const loaded = doseLoaded(key, esterDoseNow.premixG);
        const reactorDraining = draining("reactor_outlet");
        return (
          <ReactionStage
            kind="Esterification"
            esterStage={esterStage}
            state={esterState}
            setState={(nextState) => controlStage("Esterification", nextState, esterState, setEsterState)}
            oilMass={oilMassG}
            oilVolume={oilVolumeMl}
            catalyst={catalyst}
            ratio={ratio}
            esterDose={esterDoseNow}
            transDose={transDoseNow}
            transExact={transExact}
            voltage={Number(esterVoltage)}
            time={Number(esterTime)}
            stirring={Number(esterStirring)}
            batchId={batchId}
            onContinue={next}
            liveStage={liveStageFor("Esterification")}
            connected={backend}
            liveMock={mock}
            onReset={() => resetStage(setEsterState)}
            startBlocked={run?.phase === "pumping" ? "Pump B is still loading." : !loaded ? "Load the dose with pump B first (or tick that you added it by hand)." : null}
            hideContinue
            preparation={
              <DosingPanel
                pump="acid"
                premixParts={[`${esterDoseNow.methanolMl.toFixed(1)} mL methanol`, `${esterDoseNow.sulfuricAcidMl.toFixed(2)} mL sulfuric acid (98%)`]}
                mixingNote="Pour the acid slowly into the methanol while stirring (never the other way round); it gets warm."
                targetG={esterDoseNow.premixG}
                premixMl={esterDoseNow.premixMl}
                run={run}
                completedG={loads[key]?.completedG ?? 0}
                manual={loads[key]?.manual ?? false}
                setManual={(value) => setManualDose(key, value)}
                onLoad={() => loadDose(key, "acid", esterDoseNow.premixG, esterDoseNow.premixMl)}
                onStop={stopPump}
                onSkip={realHardware ? undefined : skipPump}
                locked={reactorDraining ? "The reactor outlet is open." : pumpRunning && run?.phase !== "pumping" ? "The other pump is running." : null}
                acetone={esterStage === 1 && esterDoseNow.acetoneG > 0 ? {
                  ml: esterDoseNow.acetoneMl,
                  g: esterDoseNow.acetoneG,
                  addedG: acetonePouredG(key),
                  onDemoAdd: realHardware ? undefined : () => pourDemoAcetone(esterDoseNow.acetoneG - acetonePouredG(key)),
                } : null}
                reactorG={reactorG}
                live={realHardware}
              />
            }
            footer={esterState === "complete" ? (
              <RecheckPanel
                stage={esterStage}
                value={recheckValue}
                setValue={setRecheckValue}
                aboveStrip={recheckAbove}
                setAboveStrip={setRecheckAbove}
                settings={chemistrySettings}
                next={recheckNext}
                catalyst={catalyst}
                onAnotherStage={prepareNextEsterStage}
                onContinue={finishEsterification}
              />
            ) : null}
          />
        );
      })()}

      {currentStage === "Transesterification" && doseKey && (() => {
        const key = doseKey;
        const run = pumpRunFor(key);
        const loaded = doseLoaded(key, transDoseNow.premixG);
        return (
          <ReactionStage
            kind="Transesterification"
            state={transState}
            setState={(nextState) => controlStage("Transesterification", nextState, transState, setTransState)}
            oilMass={oilMassG}
            oilVolume={oilVolumeMl}
            catalyst={catalyst}
            ratio={ratio}
            esterDose={esterDoseNow}
            transDose={transDoseNow}
            transExact={transExact}
            voltage={Number(transVoltage)}
            time={Number(transTime)}
            stirring={Number(transStirring)}
            batchId={batchId}
            onContinue={next}
            liveStage={liveStageFor("Transesterification")}
            connected={backend}
            liveMock={mock}
            onReset={() => resetStage(setTransState)}
            startBlocked={run?.phase === "pumping" ? "Pump A is still loading." : !loaded ? "Load the dose with pump A first (or tick that you added it by hand)." : null}
            preparation={
              <DosingPanel
                pump="catalyst"
                premixParts={[`${transDoseNow.catalystToWeighG.toFixed(2)} g ${catalyst}`, `${transDoseNow.methanolMl.toFixed(1)} mL methanol`]}
                mixingNote={`Stir until the ${catalyst} has fully dissolved; it gets warm.`}
                targetG={transDoseNow.premixG}
                premixMl={transDoseNow.premixMl}
                run={run}
                completedG={loads[key]?.completedG ?? 0}
                manual={loads[key]?.manual ?? false}
                setManual={(value) => setManualDose(key, value)}
                onLoad={() => loadDose(key, "catalyst", transDoseNow.premixG, transDoseNow.premixMl)}
                onStop={stopPump}
                onSkip={realHardware ? undefined : skipPump}
                locked={draining("reactor_outlet") ? "The reactor outlet is open." : pumpRunning && run?.phase !== "pumping" ? "The other pump is running." : null}
                acetone={transDoseNow.acetoneG > 0 ? {
                  ml: transDoseNow.acetoneMl ?? 0,
                  g: transDoseNow.acetoneG,
                  addedG: acetonePouredG(key),
                  onDemoAdd: realHardware ? undefined : () => pourDemoAcetone(transDoseNow.acetoneG - acetonePouredG(key)),
                } : null}
                reactorG={reactorG}
                live={realHardware}
              />
            }
            footer={transState === "complete" ? (
              <DrainPanel
                valve="reactor_outlet"
                view={drainViewFor("reactor_outlet")}
                minutes={drainMinutes("reactor_outlet")}
                onAgain={() => openDrainAgain("reactor_outlet")}
                onStop={closeDrain}
                onSkip={realHardware ? undefined : skipDrain}
              />
            ) : null}
          />
        );
      })()}

      {currentStage === "Separation" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader eyebrow={`Batch ${batchId}`} title="Separation" description="Separating biodiesel and glycerol." />
            <Status tone={separationState === "complete" ? "green" : separationState === "fault" ? "red" : "blue"}>{separationState.toUpperCase()}</Status>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Card className="p-5"><Metric label="Configured duration" value={`${PROCESS_CONFIG.separation.timeMinutes} min`} /></Card>
            <Card className="p-5"><Metric label="Configured speed" value={`${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} /></Card>
            <Card className="p-5"><Metric label="Elapsed" value={liveSeparation ? formatTimer(liveSeparation.elapsedSeconds) : separationState === "complete" ? "10 min" : separationState === "running" ? "6 min" : "0 min"} /></Card>
            <Card className="p-5"><Metric label="Remaining" value={liveSeparation ? formatTimer(liveSeparation.remainingSeconds) : separationState === "complete" ? "0 min" : separationState === "running" ? "4 min" : "10 min"} /></Card>
            <Card className="p-5"><Metric label="Batch ID" value={batchId} sub={liveSeparation && liveSeparation.liveRpm != null ? `Centrifuge ${liveSeparation.liveRpm.toLocaleString()} RPM` : undefined} /></Card>
          </div>
          <div className="mt-6"><Progress value={liveSeparation && liveSeparation.timeMinutes ? (liveSeparation.elapsedSeconds / (liveSeparation.timeMinutes * 60)) * 100 : separationState === "complete" ? 100 : separationState === "running" ? 60 : 0} /></div>
          <p className="mt-4 text-xs leading-5 text-gray-500">{liveSeparation ? (mock ? "Simulated by the Greenova backend (demo mode)." : "Live from the Raspberry Pi. The centrifuge stops by itself when the time is over.") : "Demonstration state only."} The centrifuge controller must verify lid interlock, balance, and required safety conditions before operation. When separation finishes and the centrifuge has stopped, its outlet valve opens by itself and the biodiesel flows to the purification tank; purification then starts by itself.</p>
          {liveSeparation?.faultReason && <p className="mt-2 text-sm text-red-400">Stopped: {liveSeparation.faultReason}</p>}
          {separationState === "ready" && drainViewFor("reactor_outlet") && (
            <DrainPanel valve="reactor_outlet" view={drainViewFor("reactor_outlet")} minutes={drainMinutes("reactor_outlet")} onStop={closeDrain} onSkip={realHardware ? undefined : skipDrain} />
          )}
          <StageControls state={separationState} setState={(nextState) => controlStage("Separation", nextState, separationState, setSeparationState)} startLabel={backend ? "Start centrifuge" : "Record centrifuge start"} onContinue={next} continueLabel="Continue to Purification" onReset={() => resetStage(setSeparationState)} startBlocked={draining("reactor_outlet") ? "Wait for the reactor outlet to close: the reactor is still draining into the centrifuge." : null} />
        </Card>
      )}

      {currentStage === "Purification" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              eyebrow={`Batch ${batchId}`}
              title="Purification"
              description={`Runs by itself: heats to ${Number(targetTemperature)} °C and holds ${purificationSettings.holdTimeMinutes} min with the dry wash stirrer running, to remove leftover methanol. Then the outlet valve lets the biodiesel through the activated-bentonite mesh bed into the biodiesel container, which the output load cell weighs. Confirm when it's finished.`}
            />
            <Status tone={purificationPhase === "complete" ? "green" : purificationPhase === "fault" ? "red" : PURIFYING.includes(purificationPhase) ? "yellow" : "neutral"}>
              {purificationPhase === "flow" ? "MESH BED FLOW" : purificationPhase === "hold" ? "HOLDING" : purificationPhase === "drain" ? "DRAINING" : purificationPhase === "ready" ? "WAITING" : purificationPhase.toUpperCase()}
            </Status>
          </div>

          <div className="mt-7 flex items-center">
            {["Heating", "Holding", "Mesh bed flow", "Draining", "Complete"].map((label, index) => {
              const activeIndex = { ready: 0, heating: 0, fault: 0, hold: 1, flow: 2, drain: 3, complete: 4 }[purificationPhase];
              const done = index < activeIndex || purificationPhase === "complete";
              return (
                <div key={label} className="relative flex flex-1 flex-col items-center text-center">
                  {index < 4 && <div className={`absolute left-1/2 top-3 h-px w-full ${index < activeIndex ? "bg-green-500/60" : "bg-white/10"}`} />}
                  <div className={`relative z-10 h-6 w-6 rounded-full border ${done ? "border-green-500 bg-green-500" : index === activeIndex ? "border-green-400 bg-green-500/15" : "border-white/10 bg-gv-surface"}`} />
                  <div className={`mt-2 text-xs ${index === activeIndex && !done ? "text-white" : done ? "text-green-400" : "text-gray-600"}`}>{label}</div>
                </div>
              );
            })}
          </div>

          {(purificationPhase === "ready" || centrifugeDraining) && drainViewFor("centrifuge_outlet") && (
            <DrainPanel
              valve="centrifuge_outlet"
              view={drainViewFor("centrifuge_outlet")}
              minutes={drainMinutes("centrifuge_outlet")}
              onAgain={purificationPhase === "ready" ? () => openDrainAgain("centrifuge_outlet") : undefined}
              onStop={closeDrain}
              onSkip={realHardware ? undefined : skipDrain}
            />
          )}

          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Card className="p-5">
              <Metric label="Live temperature" value={liveTemperature === null ? "Unavailable" : `${liveTemperature.toFixed(1)} °C`} sub={`Target ${Number(targetTemperature).toFixed(1)} °C · ${realHardware ? "Live sensor" : "Demonstration"}`} />
              <div className="mt-4"><Progress value={liveTemperature === null ? 0 : ((liveTemperature - startingTemperature) / Math.max(Number(targetTemperature) - startingTemperature, 1)) * 100} /></div>
            </Card>
            <Card className="p-5">
              <Metric
                label="Automatic plan"
                value={`${Number(targetTemperature)} °C · ${purificationSettings.holdTimeMinutes} min`}
                sub={`Flow ${formatMinutes(shownPlannedFlowSeconds)}${shownBiodieselMl ? ` for ${shownBiodieselMl.toFixed(0)} mL` : ""} at ${purificationSettings.flowRateMlPerMinute} mL/min · drain up to ${purificationSettings.drainTimeMinutes} min`}
              />
            </Card>
            <Card className="p-5">
              <div className="gv-label">Immersion heater</div>
              <Status tone={heaterOn ? "yellow" : "neutral"}>{heaterOn ? "● ON" : "OFF"}</Status>
            </Card>
            <Card className="p-5">
              <div className="gv-label">Dry wash stirrer</div>
              <Status tone={stirrerOn ? "green" : "neutral"}>{stirrerOn ? "● RUNNING" : "OFF"}</Status>
              <div className="mt-2 text-xs text-gray-500">
                {stirrerOn ? `${stirrerRpm == null ? "RPM reading unavailable" : `${stirrerRpm} RPM`} · set ${transferSettings.stirringSpeed} RPM` : `Runs during heating and hold · ${transferSettings.stirringSpeed} RPM`}
              </div>
            </Card>
            <Card className="p-5">
              <div className="gv-label">Purification outlet valve</div>
              <Status tone={purificationPhase === "flow" || purificationPhase === "drain" ? "green" : "neutral"}>{purificationPhase === "flow" || purificationPhase === "drain" ? "OPEN" : "CLOSED"}</Status>
              <div className="mt-2 text-xs text-gray-500">To the mesh bed, then the biodiesel container</div>
            </Card>
            <Card className="p-5">
              <Metric
                label="Timer"
                value={
                  purificationPhase === "heating" ? formatTimer(heatingTimeSeconds)
                    : purificationPhase === "hold" ? formatTimer(holdRemainingSeconds)
                      : purificationPhase === "flow" ? formatTimer(Math.max(shownPlannedFlowSeconds - flowElapsedSeconds, 0))
                        : purificationPhase === "drain" ? formatTimer(drainElapsedSeconds)
                          : purificationPhase === "complete" ? "Done"
                            : "00:00"
                }
                sub={
                  purificationPhase === "heating" ? `Heating to ${Number(targetTemperature)} °C · about 1 min expected`
                    : purificationPhase === "hold" ? "Hold remaining · removing leftover methanol"
                      : purificationPhase === "flow" ? `Flow remaining · ${formatTimer(flowElapsedSeconds)} elapsed`
                        : purificationPhase === "drain" ? `Draining · output steady ${flowStableSeconds} s`
                          : purificationPhase === "complete" ? `${formatMinutes(Math.round(purificationSettings.holdTimeMinutes * 60) - holdRemainingSeconds)} hold · ${formatMinutes(flowElapsedSeconds)} flow · ${formatTimer(drainElapsedSeconds)} drain`
                            : purificationPhase === "fault" ? "Stopped"
                              : centrifugeDraining ? "Waiting for the centrifuge outlet"
                                : showManualStart ? "Waiting for Start purification" : "Starts by itself"
                }
              />
            </Card>
          </div>

          {(purificationPhase === "flow" || purificationPhase === "drain" || (purificationPhase === "complete" && outputWeightG > 0)) && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Card className="p-5"><Metric label="Biodiesel collected" value={`${outputWeightG.toFixed(1)} g`} sub={`Output load cell · ${realHardware ? "Live" : "Demonstration"}${shownBiodieselMl ? ` · about ${(shownBiodieselMl * 0.88).toFixed(0)} g expected` : ""}`} /></Card>
              <Card className="p-5"><Metric label="Flow rate" value={`${flowRateGPerMinute.toFixed(1)} g/min`} sub={purificationPhase === "drain" ? "Closes when nothing more comes out for 1 min" : `Planned ${purificationSettings.flowRateMlPerMinute} mL/min`} /></Card>
            </div>
          )}

          {purificationPhase === "hold" && (
            <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-4 text-sm text-amber-400">
              Holding at {Number(targetTemperature)} °C — removing leftover methanol
            </div>
          )}

          {purificationPhase === "ready" && autoStartPending && levelSwitch === false && (
            <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/[0.04] p-5 text-sm text-amber-400">
              Waiting for biodiesel to cover the heater. Purification starts by itself when the level switch detects it.
            </div>
          )}
          {purificationPhase === "ready" && autoStartPending && levelSwitch === true && (
            <div className="mt-6 rounded-xl border border-green-500/20 bg-green-500/[0.04] p-5 text-sm text-green-400">Starting purification…</div>
          )}

          {purificationWarning && (
            <div className="mt-6 rounded-xl border border-amber-400/25 bg-amber-400/[0.05] p-5 text-sm text-amber-400">{purificationWarning}</div>
          )}

          {safetyStopReason && (
            <div className="mt-6 rounded-xl border border-red-500/25 bg-red-500/[0.06] p-5">
              <div className="font-display font-semibold text-red-400">Heater stopped: {safetyStopReason}</div>
              <p className="mt-1 text-xs text-gray-500">Heater OFF · valve CLOSED</p>
              <Button className="mt-4" variant="danger" onClick={acknowledgeSafetyStop}>Acknowledge</Button>
            </div>
          )}

          {purificationPhase === "complete" && (
            <div className="mt-6 rounded-xl border border-green-500/25 bg-green-500/[0.05] p-5">
              <div className="font-display font-semibold text-green-400">Purification complete</div>
              <p className="mt-1 text-sm text-gray-400">The valve is closed. Check the collected biodiesel, then confirm that the process is finished.</p>
            </div>
          )}

          <div className="mt-6 space-y-2 rounded-xl border border-white/[0.07] bg-gv-inset p-5 text-xs leading-5 text-gray-500">
            <p>{purificationSettings.thermalFuseRating === null ? "Hardware backup: a thermal fuse cuts heater power if the software fails (set its rating in Settings)." : `Hardware backup: a thermal fuse cuts heater power at ${purificationSettings.thermalFuseRating} °C if the software fails.`} The heater also stops above {purificationSettings.maximumTemperature} °C.</p>
            <p className="text-amber-400">Heat in a ventilated area. Leftover methanol evaporates when heated.</p>
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-4">
            {showManualStart && (
              <>
                {backend && levelSwitch === null && (
                  <label className="flex items-center gap-2 text-sm text-gray-300">
                    <input className="gv-checkbox" type="checkbox" checked={heaterConfirmed} onChange={(event) => setHeaterConfirmed(event.target.checked)} />
                    No level switch installed: I checked that the heater is fully submerged
                  </label>
                )}
                <Button
                  disabled={(backend && levelSwitch === null && !heaterConfirmed) || (backend && levelSwitch === false) || liveTemperature === null}
                  onClick={() => startPurificationNow(false)}
                >
                  {safetyStopOccurred ? "Start purification again" : "Start purification"}
                </Button>
                {backend && levelSwitch === false && <span className="text-xs text-amber-400">The level switch doesn't detect biodiesel at the heater.</span>}
              </>
            )}
            {PURIFYING.includes(purificationPhase) && (
              <Button variant="danger" onClick={stopPurification}>Stop</Button>
            )}
            {PURIFYING.includes(purificationPhase) && !realHardware && (
              <Button variant="secondary" onClick={skipPurificationPhase}>Skip timer (demo)</Button>
            )}
            {purificationPhase === "complete" && <Button onClick={completeBatch}>Confirm process finished →</Button>}
          </div>
        </Card>
      )}

      {currentStage === "Process Complete" && (
        <Card className="overflow-hidden">
          <div className="border-b border-green-500/10 bg-green-500/[0.04] p-8 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gv-green text-2xl font-bold text-black">✓</div>
            <Heading as="h1" className="mt-5 text-3xl font-bold">Process Complete</Heading>
            <p className="mt-2 text-sm text-gray-500">{savedBatch?.createdAt ? "The batch has been saved on the Raspberry Pi, together with the values it measured." : "The recorded batch information has been saved to local history."}</p>
            <p className="mt-3 text-sm text-amber-400">Lab result pending. Record it in Batch History when the lab certificate arrives.</p>
          </div>
          <div className="p-6 sm:p-8">
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <Metric label="Batch ID" value={batchId} accent />
              <Metric label="Oil volume" value={oilVolumeMl === null ? "Not available" : `${oilVolumeMl.toFixed(1)} mL`} sub="Converted using configured density" />
              <Metric label="Oil mass" value={`${oilMassG.toFixed(1)} g`} sub={realHardware ? "Load-cell record" : "Demonstration load-cell record"} />
              <Metric label="FFA percentage" value={formatFfa({ ffa: ffaNumber, ffaAboveStrip })} sub={ffaAboveStrip ? "Strip's darkest color · operator entered" : "Test strip · operator entered"} />
              <Metric label="Reaction pathway" value={requiresEsterification ? `Esterification${esterStagesRun > 1 ? ` (${esterStagesRun} stages)` : ""} → Transesterification` : "Transesterification"} />
              {requiresEsterification && (
                <Metric
                  label="FFA re-checks"
                  value={esterRecords.length ? [formatFfa({ ffa: ffaNumber, ffaAboveStrip }), ...esterRecords.map((record) => `${(record.ffaAfter ?? 0).toFixed(1)}%`)].join(" → ") : "Not recorded"}
                  sub={`Stage 1 dosed for ${chemistrySettings.designFfa}% FFA (uniform)`}
                />
              )}
              {requiresEsterification && <Metric label="Esterification duration" value={`${Number(esterTime) * esterStagesRun} min`} sub={esterStagesRun > 1 ? `${esterStagesRun} × ${esterTime} min` : undefined} />}
              <Metric label="Transesterification duration" value={`${transTime} min`} />
              <Metric label="Methanol-to-oil ratio" value={`${ratio}:1`} sub="Molar convention" />
              <Metric label="Methanol" value={`${(transDoseNow.methanolMl + esterMethanolTotal).toFixed(1)} mL`} sub={requiresEsterification ? "Esterification + transesterification · loaded by the pumps" : "Loaded by pump A"} />
              <Metric label={catalyst} value={`${transExact ? "" : "Up to "}${transDoseNow.catalystToWeighG.toFixed(2)} g`} sub={`Including neutralization · ${transDoseNow.purity}% purity${transExact ? " · exact" : ""}`} />
              <Metric label="Acetone" value={transDoseNow.acetoneMl === null ? "Unavailable" : `${acetoneTotalMl.toFixed(1)} mL`} sub="Per reaction stage · provisional · poured by hand" />
              {requiresEsterification && <Metric label="Sulfuric acid" value={`${esterAcidTotal.toFixed(2)} mL`} sub="98% · in the pump B premix" />}
              <Metric label="Separation" value={`${PROCESS_CONFIG.separation.timeMinutes} min · ${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} />
              <Metric
                label="Purification"
                value={purificationPhase === "complete" ? `${purificationAutomatic ? "Automatic" : "Completed"} · ${Number(targetTemperature)} °C` : "Not recorded"}
                sub={purificationPhase === "complete" ? `${formatMinutes(Math.round(purificationSettings.holdTimeMinutes * 60) - holdRemainingSeconds)} hold · ${formatMinutes(flowElapsedSeconds)} flow · ${formatMinutes(drainElapsedSeconds)} drain` : undefined}
              />
              <Metric label="Biodiesel output" value={savedBatch?.biodieselOutputMl ? `${savedBatch.biodieselOutputMl.toFixed(1)} mL · ${savedBatch.yield}% yield` : "Not measured"} sub={savedBatch?.biodieselOutputMl ? `Output load cell${savedBatch.purification?.outputWeightG ? ` · ${savedBatch.purification.outputWeightG.toFixed(1)} g` : ""}` : undefined} />
              {savedBatch?.createdAt && <Metric label="Average reaction temperature" value={`${savedBatch.temperature} °C`} sub="Measured during transesterification" />}
              {savedBatch?.createdAt && <Metric label="Energy used" value={`${savedBatch.energy} kWh`} sub="Electrodes (plus heater, if configured)" />}
              <Metric label="Completion date" value={new Date().toLocaleString()} />
            </div>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link to="/dashboard" className="btn-primary">Return to Dashboard</Link>
              <Link to="/batches" className="btn-secondary">View Batch History →</Link>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
