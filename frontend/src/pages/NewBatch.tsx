import { useEffect, useMemo, useRef, useState } from "react";
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
  getNextBatchId,
  getRecommendedParametersForFfa,
  getSystemStatus,
  isOffline,
  loadDemoOil,
  purificationAction,
  saveCompletedBatch,
  stageAction,
  startPurification,
  startStage,
  type BatchRecord,
  type StageName,
  type StageStatus,
  type SystemStatus,
} from "../lib/api";

type DeviceState = "ready" | "checking" | "fault";
type StageState = "ready" | "running" | "paused" | "complete" | "fault";
type PurificationPhase = "ready" | "heating" | "hold" | "flow" | "drain" | "complete" | "fault";
const PURIFYING: PurificationPhase[] = ["heating", "hold", "flow", "drain"];
type ChemistrySettings = {
  oilMolarMass: number;
  kohPurity: number;
  naohPurity: number;
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
  const defaults = { oilMolarMass: 880, kohPurity: 90, naohPurity: 98 };
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

function calculateQuantityCards(
  oilMassG: number,
  oilVolumeMl: number | null,
  ffa: number,
  ratio: number,
  catalyst: "NaOH" | "KOH",
  settings: ChemistrySettings,
) {
  const ffaMassG = oilMassG * (ffa / 100);
  const esterificationNeeded = ffa > PROCESS_CONFIG.ffaThreshold;
  const catalystBaseG = oilMassG * 0.01;
  const neutralizationFfa = esterificationNeeded ? 1 : ffa;
  const neutralizationFactor = catalyst === "KOH" ? 0.199 : 0.142;
  const neutralizationG =
    oilMassG * (neutralizationFfa / 100) * neutralizationFactor;
  const purity = catalyst === "KOH" ? settings.kohPurity : settings.naohPurity;

  return {
    ffaMassG,
    esterificationNeeded,
    esterificationMethanolMl: ffaMassG * 2.84,
    sulfuricAcidMl: ffaMassG * 0.027,
    acetoneMl: oilVolumeMl === null ? null : oilVolumeMl * 0.1,
    transesterificationMethanolMl:
      (oilMassG * ratio * 40.45) / settings.oilMolarMass,
    catalystBaseG,
    neutralizationG,
    catalystToWeighG: (catalystBaseG + neutralizationG) / (purity / 100),
    purity,
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
    <div className="rounded-xl border border-white/[0.07] bg-black/10 p-4">
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
}: {
  state: StageState;
  setState: (state: StageState) => void;
  startLabel: string;
  onContinue: () => void;
  continueLabel: string;
  onReset?: () => void;
  error?: string | null;
}) {
  return (
    <>
    <div className="mt-7 flex flex-wrap gap-3">
      {state === "ready" && <Button onClick={() => setState("running")}>{startLabel}</Button>}
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
      {state === "complete" && <Button onClick={onContinue}>{continueLabel} →</Button>}
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

function ReactionStage({
  kind,
  state,
  setState,
  oilMass,
  oilVolume,
  catalyst,
  ratio,
  quantities,
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
}: {
  kind: "Esterification" | "Transesterification";
  state: StageState;
  setState: (state: StageState) => void;
  oilMass: number;
  oilVolume: number | null;
  catalyst: "NaOH" | "KOH";
  ratio: number;
  quantities: ReturnType<typeof calculateQuantityCards>;
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
}) {
  const isEsterification = kind === "Esterification";
  const totalSeconds = time * 60;
  const elapsedSeconds = liveStage
    ? liveStage.elapsedSeconds
    : (state === "ready" ? 0 : state === "complete" ? time : Math.min(42, time)) * 60;
  const remainingSeconds = liveStage ? liveStage.remainingSeconds : Math.max(totalSeconds - elapsedSeconds, 0);
  const showTime = (seconds: number) => (liveStage ? formatTimer(seconds) : `${Math.round(seconds / 60)} min`);
  return (
    <Card className="p-6 sm:p-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <SectionHeader
          eyebrow={`Batch ${batchId}`}
          title={kind}
          description={
            isEsterification
              ? "Acid pretreatment of high-FFA feedstock before transesterification."
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
        <Card className="p-5"><Metric label="Measured oil" value={`${oilMass.toFixed(1)} g`} sub={oilVolume === null ? "Volume unavailable" : `${oilVolume.toFixed(1)} mL configured conversion`} /></Card>
        <Card className="p-5"><Metric label="Methanol" value={`${(isEsterification ? quantities.esterificationMethanolMl : quantities.transesterificationMethanolMl).toFixed(1)} mL`} sub={isEsterification ? "20:1 methanol to FFA · calculated" : `${ratio}:1 molar ratio · calculated`} /></Card>
        {isEsterification ? (
          <Card className="p-5"><Metric label="Sulfuric acid (H₂SO₄)" value={`${quantities.sulfuricAcidMl.toFixed(2)} mL`} sub="98% · 5% of FFA weight · added by hand" /></Card>
        ) : (
          <Card className="p-5"><Metric label={`${catalyst} to weigh`} value={`${quantities.esterificationNeeded ? "Up to " : ""}${quantities.catalystToWeighG.toFixed(1)} g`} sub={`${quantities.catalystBaseG.toFixed(1)} g catalyst + ${quantities.neutralizationG.toFixed(1)} g to neutralize · ${quantities.purity}% purity`} /></Card>
        )}
        <Card className="p-5"><Metric label="Acetone" value={quantities.acetoneMl === null ? "Unavailable" : `${quantities.acetoneMl.toFixed(1)} mL`} sub="Provisional 10% calculation · not dispensed" /></Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5"><Metric label="Voltage setting" value={`${voltage} V`} /></Card>
        <Card className="p-5"><Metric label="Reaction time" value={`${time} min`} /></Card>
        <Card className="p-5"><Metric label="Stirring speed" value={`${stirring} RPM`} /></Card>
        <Card className="p-5"><Metric label="Batch ID" value={batchId} /></Card>
      </div>

      <div className="mt-6 rounded-xl border border-white/[0.07] bg-black/10 p-5">
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
        startLabel={`Start ${kind}`}
        onContinue={onContinue}
        continueLabel={isEsterification ? "Continue to Transesterification" : "Continue to Separation"}
        onReset={onReset}
        error={error}
      />
    </Card>
  );
}

export default function NewBatch() {
  const [step, setStep] = useState(0);
  const [oilMassG, setOilMassG] = useState(0);
  const [targetVolume, setTargetVolume] = useState("500");
  const [ffa, setFfa] = useState("");
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
    if (live.sensors.oilMassG !== null) setOilMassG(live.sensors.oilMassG);
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
  }, [backend, live, batchId]);

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
  const ffaError = decimalError(ffa, { min: 0, max: 100 }, { empty: "Enter a valid FFA percentage." });
  const ffaNumber = Number(ffa);
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
    { label: "Load Cell", value: "Online", secondary: `${oilMassG.toFixed(1)} g · zeroed · demonstration mode` },
    {
      label: "Oil Input",
      value: oilMassG > 0 ? `${oilMassG.toFixed(1)} g` : "No oil detected",
      secondary: "Input channel ready · demonstration mode",
      state: "ready",
    },
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
    setLoadingConfirmed(false);
    setActionError(null);
    if (backend) {
      try {
        const sensors = await loadDemoOil(Number(targetVolume || 0));
        if (sensors.oilMassG !== null) setOilMassG(sensors.oilMassG);
      } catch (error) {
        setActionError(errorText(error));
      }
      return;
    }
    setOilMassG(Number(targetVolume || 0) * PROCESS_CONFIG.oil.densityGPerMl);
  }

  /** Stage buttons: the backend runs the stage when it's connected; otherwise the local demo. */
  async function controlStage(kind: StageName, nextState: StageState, current: StageState, setLocal: (state: StageState) => void) {
    setActionError(null);
    if (!backend) {
      setLocal(nextState);
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
    autoStarted.current = true;
    startPurificationNow(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, currentStage, purificationPhase]);

  const levelSwitch = backend && live ? live.sensors.heaterSubmerged : null;
  const autoStartPending = backend && live !== null && live.purificationAutoStart === batchId;
  const showManualStart =
    purificationPhase === "ready" && !safetyStopReason && (!backend || !autoStartPending || levelSwitch === null);
  const shownPlannedFlowSeconds = plannedFlowSeconds ?? plannedFlowSecondsFor(oilVolumeMl, purificationSettings);
  const shownBiodieselMl = expectedBiodieselMl ?? oilVolumeMl;

  async function completeBatch() {
    if (!saved) {
      setActionError(null);
      const totalReactionTime =
        Number(transTime) + (requiresEsterification ? Number(esterTime) : 0);
      let result: BatchRecord;
      try {
        result = await saveCompletedBatch({
          id: batchId,
          date: new Date().toISOString().slice(0, 10),
          oilVolume: Number((oilVolumeMl ?? 0).toFixed(1)),
          yield: 0,
          duration: totalReactionTime + PROCESS_CONFIG.separation.timeMinutes,
          energy: 0,
          status: "Completed",
          labResult: "Pending",
          ffa: ffaNumber,
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
              <p className="mt-1 text-sm text-gray-500">The load cell is authoritative for actual oil mass.</p>
              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <ReadOnlyTile label="Live oil mass" value={`${oilMassG.toFixed(1)} g`} secondary={realHardware ? "Load cell · live" : "Load cell · demonstration channel"} state={oilMassG > 0 ? "ready" : "checking"} />
                <ReadOnlyTile label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} secondary={`Configured density: ${PROCESS_CONFIG.oil.densityGPerMl} g/mL · assumed`} state={oilMassG > 0 ? "ready" : "checking"} />
              </div>
              <div className="mt-5">
                <Field label="Target batch volume" inputMode="decimal" value={targetVolume} onChange={(event) => { setTargetVolume(event.target.value); setLoadingConfirmed(false); }} unit="mL" aria-invalid={Boolean(targetError)} />
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
              <p className="mt-1 text-sm text-gray-500">Measure the feedstock using the FFA test strips, then enter the observed result.</p>
              <div className="mt-6">
                <Field label="FFA Percentage" inputMode="decimal" value={ffa} onChange={(event) => setFfa(event.target.value)} unit="%" aria-invalid={Boolean(ffaError)} />
                {ffaError && <p className="mt-2 text-xs text-red-400">{ffaError}</p>}
              </div>
              {!ffaError && (
                <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.025] p-4">
                  <div className="gv-label">Pathway decision · threshold {PROCESS_CONFIG.ffaThreshold.toFixed(1)}%</div>
                  <p className="text-sm text-gray-300">
                    {requiresEsterification
                      ? "Esterification required before transesterification."
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
                {calculatorReady && requiresEsterification && <Status tone="yellow">FFA above 4%</Status>}
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
                      secondary={calculatorReady ? `20:1 methanol to FFA · ${calculatorValues.ffaMassG.toFixed(1)} g FFA × 2.84` : undefined}
                    />
                    <ReadOnlyTile
                      label="Sulfuric acid 98%"
                      value={calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—"}
                      secondary={calculatorReady ? `5% of FFA weight · ${calculatorValues.ffaMassG.toFixed(1)} g FFA × 0.027` : undefined}
                    />
                    <ReadOnlyTile
                      label="Acetone"
                      value={calculatorReady && calculatorValues.acetoneMl !== null ? `${calculatorValues.acetoneMl.toFixed(1)} mL` : "—"}
                      secondary={calculatorReady ? "Provisional 10% of oil volume" : undefined}
                    />
                  </div>
                  {calculatorReady && requiresEsterification && (
                    <p className="mt-3 text-xs leading-5 text-gray-500">
                      If FFA is still above 1% after this stage, the next stage's amounts appear on the Esterification step.
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
                        : `${calculatorValues.catalystBaseG.toFixed(1)} g catalyst + ${calculatorValues.neutralizationG.toFixed(1)} g to neutralize FFA · ${calculatorValues.purity}% purity`
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
                <div className="rounded-xl border border-white/[0.07] bg-black/10 p-5">
                  <div className="flex items-center justify-between gap-3"><Heading as="h3" className="text-base font-semibold">Esterification Settings</Heading><Status tone="yellow">Acid added by hand</Status></div>
                  <div className="mt-5 grid gap-5 sm:grid-cols-3">
                    <ParameterField label="Voltage" value={esterVoltage} setValue={setEsterVoltage} unit="V" limits={PROCESS_CONFIG.esterification.voltage} />
                    <ParameterField label="Reaction time" value={esterTime} setValue={setEsterTime} unit="min" limits={PROCESS_CONFIG.esterification.time} />
                    <ParameterField label="Stirring speed" value={esterStirring} setValue={setEsterStirring} unit="RPM" limits={PROCESS_CONFIG.esterification.stirring} />
                  </div>
                  <p className="mt-4 text-xs text-amber-400">Sulfuric acid (98%): {calculatorReady ? `${calculatorValues.sulfuricAcidMl.toFixed(2)} mL` : "—"}, added by hand. Greenova does not dispense it.</p>
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
          <SectionHeader eyebrow="Manual stage" title="Oil Loading" description="Manually load the oil while Greenova monitors the demonstration load-cell channel." />
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5"><Metric label="Target oil volume" value={`${Number(targetVolume).toFixed(1)} mL`} /></Card>
            <Card className="p-5"><Metric label="Live measured mass" value={`${oilMassG.toFixed(1)} g`} sub={realHardware ? "Live load-cell data" : "Demonstration load-cell data"} /></Card>
            <Card className="p-5"><Metric label="Converted volume" value={oilVolumeMl === null ? "Unavailable" : `${oilVolumeMl.toFixed(1)} mL`} sub="Using configured assumed density" /></Card>
            <Card className="p-5"><Metric label="Loading status" value={loadingConfirmed ? "Quantity confirmed" : loadingStatus} accent={targetReached} /></Card>
          </div>
          <div className="mt-6 rounded-xl border border-white/[0.07] bg-black/10 p-5">
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
            <Button disabled={!targetReached} onClick={() => setLoadingConfirmed(true)} variant={loadingConfirmed ? "secondary" : "primary"}>{loadingConfirmed ? "Quantity confirmed" : "Confirm detected quantity"}</Button>
            {loadingConfirmed && <Button onClick={next}>Continue to {requiresEsterification ? "Esterification" : "Transesterification"} →</Button>}
          </div>
        </Card>
      )}

      {currentStage === "Esterification" && (
        <ReactionStage kind="Esterification" state={esterState} setState={(nextState) => controlStage("Esterification", nextState, esterState, setEsterState)} oilMass={oilMassG} oilVolume={oilVolumeMl} catalyst={catalyst} ratio={ratio} quantities={calculatorValues} voltage={Number(esterVoltage)} time={Number(esterTime)} stirring={Number(esterStirring)} batchId={batchId} onContinue={next} liveStage={liveStageFor("Esterification")} connected={backend} liveMock={mock} onReset={() => resetStage(setEsterState)} />
      )}

      {currentStage === "Transesterification" && (
        <ReactionStage kind="Transesterification" state={transState} setState={(nextState) => controlStage("Transesterification", nextState, transState, setTransState)} oilMass={oilMassG} oilVolume={oilVolumeMl} catalyst={catalyst} ratio={ratio} quantities={calculatorValues} voltage={Number(transVoltage)} time={Number(transTime)} stirring={Number(transStirring)} batchId={batchId} onContinue={next} liveStage={liveStageFor("Transesterification")} connected={backend} liveMock={mock} onReset={() => resetStage(setTransState)} />
      )}

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
          <p className="mt-4 text-xs leading-5 text-gray-500">{liveSeparation ? (mock ? "Simulated by the Greenova backend (demo mode)." : "Live from the Raspberry Pi. The centrifuge stops by itself when the time is over.") : "Demonstration state only."} The centrifuge controller must verify lid interlock, balance, and required safety conditions before operation. When separation finishes, purification starts by itself.</p>
          {liveSeparation?.faultReason && <p className="mt-2 text-sm text-red-400">Stopped: {liveSeparation.faultReason}</p>}
          <StageControls state={separationState} setState={(nextState) => controlStage("Separation", nextState, separationState, setSeparationState)} startLabel={backend ? "Start centrifuge" : "Record centrifuge start"} onContinue={next} continueLabel="Continue to Purification" onReset={() => resetStage(setSeparationState)} />
        </Card>
      )}

      {currentStage === "Purification" && (
        <Card className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <SectionHeader
              eyebrow={`Batch ${batchId}`}
              title="Purification"
              description={`Runs by itself: heats to ${Number(targetTemperature)} °C, holds ${purificationSettings.holdTimeMinutes} min to remove leftover methanol, passes the biodiesel through the activated-bentonite mesh bed, then drains. Confirm when it's finished.`}
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

          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
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
              <div className="gv-label">Mesh bed valve</div>
              <Status tone={purificationPhase === "flow" || purificationPhase === "drain" ? "green" : "neutral"}>{purificationPhase === "flow" || purificationPhase === "drain" ? "OPEN" : "CLOSED"}</Status>
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

          <div className="mt-6 space-y-2 rounded-xl border border-white/[0.07] bg-black/10 p-5 text-xs leading-5 text-gray-500">
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
              <Metric label="FFA percentage" value={`${ffaNumber.toFixed(1)}%`} sub="Operator entered" />
              <Metric label="Reaction pathway" value={requiresEsterification ? "Esterification → Transesterification" : "Transesterification"} />
              {requiresEsterification && <Metric label="Esterification duration" value={`${esterTime} min`} />}
              <Metric label="Transesterification duration" value={`${transTime} min`} />
              <Metric label="Methanol-to-oil ratio" value={`${ratio}:1`} sub="Molar convention" />
              <Metric label="Calculated methanol" value={`${(calculatorValues.transesterificationMethanolMl + (requiresEsterification ? calculatorValues.esterificationMethanolMl : 0)).toFixed(1)} mL`} sub={requiresEsterification ? "Esterification + transesterification · calculated" : "Calculated, not recorded as dispensed"} />
              <Metric label={`Calculated ${catalyst}`} value={`${requiresEsterification ? "Up to " : ""}${calculatorValues.catalystToWeighG.toFixed(1)} g`} sub={`Including neutralization · ${calculatorValues.purity}% purity`} />
              <Metric label="Calculated acetone" value={calculatorValues.acetoneMl === null ? "Unavailable" : `${calculatorValues.acetoneMl.toFixed(1)} mL`} sub="Per reaction stage · provisional" />
              {requiresEsterification && <Metric label="Sulfuric acid" value={`${calculatorValues.sulfuricAcidMl.toFixed(2)} mL`} sub="98% · calculated" />}
              <Metric label="Separation" value={`${PROCESS_CONFIG.separation.timeMinutes} min · ${PROCESS_CONFIG.separation.speedRpm.toLocaleString()} RPM`} />
              <Metric
                label="Purification"
                value={purificationPhase === "complete" ? `${purificationAutomatic ? "Automatic" : "Completed"} · ${Number(targetTemperature)} °C` : "Not recorded"}
                sub={purificationPhase === "complete" ? `${formatMinutes(Math.round(purificationSettings.holdTimeMinutes * 60) - holdRemainingSeconds)} hold · ${formatMinutes(flowElapsedSeconds)} flow · ${formatMinutes(drainElapsedSeconds)} drain` : undefined}
              />
              <Metric label="Biodiesel output" value={savedBatch?.biodieselOutputMl ? `${savedBatch.biodieselOutputMl.toFixed(1)} mL · ${savedBatch.yield}% yield` : "Not measured"} sub={savedBatch?.biodieselOutputMl ? "Output load cell" : undefined} />
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
