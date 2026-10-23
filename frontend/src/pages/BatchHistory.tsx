import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { batchTone, Card, Heading, Metric, Status } from "../components/ui";
import { ffaBoundaries, formatFfa, type BatchData } from "../lib/greenovaData";
import { useBatches } from "../lib/api";
import { useT, type TFunction } from "../lib/i18n";

const chartColors = {
  green: "#22c55e",
  red: "#ef4444",
  blue: "#60a5fa",
  amber: "#fbbf24",
  // theme colors (see src/index.css), so the charts follow light and dark mode
  grid: "var(--gv-chart-grid)",
  text: "var(--gv-chart-text)",
  label: "var(--gv-chart-label)",
};

type FfaRange = {
  key: string;
  label: string;
  min: number;
  max: number | null;
};

type AnalyticsSettings = {
  ranges: FfaRange[];
  provenBatchCount: number;
  provenYieldTolerance: number;
  prices: {
    oil: number;
    methanol: number;
    koh: number;
    naoh: number;
    sulfuricAcid: number;
    acetone: number;
    bentonite: number;
    magnesol: number;
    diesel: number;
  };
};

function readAnalyticsSettings(): AnalyticsSettings {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem("greenova_settings") || "{}") as Record<string, unknown>;
  } catch {
    stored = {};
  }
  const numberValue = (key: string, fallback: number) => {
    const parsed = Number(stored[key]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const uniqueBoundaries = ffaBoundaries(stored.ffaRangeBoundaries);
  const ranges: FfaRange[] = uniqueBoundaries.slice(0, -1).map((min, index) => ({
    key: `${min}-${uniqueBoundaries[index + 1]}`,
    label: `${min}–${uniqueBoundaries[index + 1]}%`,
    min,
    max: uniqueBoundaries[index + 1],
  }));
  const finalBoundary = uniqueBoundaries[uniqueBoundaries.length - 1];
  // The FFA strip's darkest color: these batches are recorded at the strip's maximum.
  ranges.push({ key: `${finalBoundary}+`, label: `${finalBoundary}% and above`, min: finalBoundary, max: null });
  return {
    ranges,
    provenBatchCount: numberValue("provenBatchCount", 3),
    provenYieldTolerance: numberValue("provenYieldTolerance", 2),
    prices: {
      oil: numberValue("oilPrice", 45),
      methanol: numberValue("methanolPrice", 70),
      koh: numberValue("kohPrice", 180),
      naoh: numberValue("naohPrice", 160),
      sulfuricAcid: numberValue("sulfuricAcidPrice", 120),
      acetone: numberValue("acetonePrice", 100),
      bentonite: numberValue("bentonitePrice", 80),
      magnesol: numberValue("magnesolPrice", 250),
      diesel: numberValue("dieselPrice", 55),
    },
  };
}

function inRange(ffa: number, range: FfaRange) {
  return ffa >= range.min && (range.max === null || ffa < range.max);
}

function parameterSignature(batch: BatchData) {
  return [
    batch.esterificationRun ? batch.esterificationVoltage ?? 20 : "none",
    batch.esterificationRun ? batch.esterificationTime ?? 120 : "none",
    batch.esterificationRun ? batch.esterificationStirring ?? 500 : "none",
    batch.voltage ?? 30,
    batch.reactionTime,
    batch.stirringSpeed,
    batch.methanolRatio ?? 7,
  ].join("|");
}

function parameterDescription(t: TFunction, batch?: BatchData) {
  if (!batch) return t("Using defaults");
  const esterification = batch.esterificationRun
    ? `${t("Esterification")} ${batch.esterificationVoltage ?? 20} V · ${batch.esterificationTime ?? 120} min · ${batch.esterificationStirring ?? 500} RPM · ${t("2 stages")}`
    : t("Esterification skipped · 1 stage");
  return `${esterification}; ${t("Transesterification")} ${batch.voltage ?? 30} V · ${batch.reactionTime} min · ${batch.stirringSpeed} RPM · ${batch.methanolRatio ?? 7}:1`;
}

function buildRangeRows(tested: BatchData[], settings: AnalyticsSettings) {
  return settings.ranges.map((range) => {
    const rangeBatches = tested.filter((batch) => inRange(batch.ffa, range));
    const passed = rangeBatches.filter((batch) => batch.labResult === "Passed");
    const groups = new Map<string, BatchData[]>();
    passed.forEach((batch) => {
      const signature = parameterSignature(batch);
      groups.set(signature, [...(groups.get(signature) || []), batch]);
    });
    const ranked = [...groups.entries()]
      .map(([signature, batches]) => ({
        signature,
        batches,
        averageYield: batches.reduce((sum, batch) => sum + batch.yield, 0) / batches.length,
      }))
      .sort((a, b) => b.averageYield - a.averageYield);
    const recommendedGroup = ranked[0];
    const recommended = recommendedGroup?.batches[0];
    const matchingTested = recommendedGroup
      ? rangeBatches.filter((batch) => parameterSignature(batch) === recommendedGroup.signature)
      : [];
    const matchingAverage = recommendedGroup?.averageYield ?? 0;
    const proven =
      matchingTested.length >= settings.provenBatchCount &&
      matchingTested.every((batch) => batch.labResult === "Passed") &&
      matchingTested.every((batch) => Math.abs(batch.yield - matchingAverage) <= settings.provenYieldTolerance);
    const yields = rangeBatches.map((batch) => batch.yield);
    return {
      range,
      batches: rangeBatches,
      passed,
      recommended,
      averageYield: yields.length ? yields.reduce((sum, value) => sum + value, 0) / yields.length : null,
      minimumYield: yields.length ? Math.min(...yields) : null,
      maximumYield: yields.length ? Math.max(...yields) : null,
      status: rangeBatches.length === 0 ? "No data" : proven ? "Proven" : "Testing",
    };
  });
}

/** Cost per liter = Σ(material used × its price in Settings) ÷ liters of biodiesel collected.
 * Materials only: the energy is not measured, so it is not part of the cost. */
function calculateCostPerLiter(batch: BatchData, settings: AnalyticsSettings) {
  if (!batch.materials || !batch.biodieselOutputMl || batch.biodieselOutputMl <= 0) return null;
  const materialCost =
    batch.materials.oilL * settings.prices.oil +
    batch.materials.methanolL * settings.prices.methanol +
    batch.materials.catalystKg * (batch.catalystType === "KOH" ? settings.prices.koh : settings.prices.naoh) +
    batch.materials.sulfuricAcidL * settings.prices.sulfuricAcid +
    batch.materials.acetoneL * settings.prices.acetone +
    batch.materials.bentoniteKg * settings.prices.bentonite +
    (batch.materials.magnesolKg ?? 0) * settings.prices.magnesol;
  return materialCost / (batch.biodieselOutputMl / 1000);
}

/** Mean and range (minimum–maximum) of a list, the statistical treatment for yield and cost. */
function meanAndRange(values: number[]) {
  if (!values.length) return null;
  return {
    n: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

type Stats = ReturnType<typeof meanAndRange>;

function formatStats(stats: Stats, unit: "%" | "₱", part: "mean" | "range") {
  if (!stats) return "—";
  const show = (value: number) => (unit === "₱" ? `₱${value.toFixed(2)}` : `${value.toFixed(1)}%`);
  return part === "mean" ? show(stats.mean) : `${show(stats.min)}–${show(stats.max)}`;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; unit?: string; payload?: BatchData }>;
  label?: string;
}) {
  const t = useT();
  if (!active || !payload?.length) return null;
  const result = payload[0]?.payload?.labResult;
  return (
    <div className="rounded-lg border border-white/10 bg-gv-surface px-3 py-2 text-xs shadow-xl">
      {label && <div className="mb-1 text-gray-500">{label}</div>}
      {result && <div className={result === "Passed" ? "mb-1 text-green-400" : "mb-1 text-red-400"}>{t(result)}</div>}
      {payload.map((item) => <div key={item.name} className="font-mono text-gray-300">{t(item.name)}: {Number(item.value).toFixed(1)}{item.unit}</div>)}
    </div>
  );
}

function ResultMarker(props: { cx?: number; cy?: number; payload?: BatchData }) {
  const { cx = 0, cy = 0, payload } = props;
  const passed = payload?.labResult === "Passed";
  return <circle cx={cx} cy={cy} r={5} fill={passed ? chartColors.green : "transparent"} stroke={passed ? chartColors.green : chartColors.red} strokeWidth={2} />;
}

function ResultLegend() {
  const t = useT();
  return (
    <div className="flex items-center justify-center gap-5 text-xs text-gray-500">
      <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-green-500" />{t("Passed")}</span>
      <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full border-2 border-red-500" />{t("Failed")}</span>
    </div>
  );
}

export default function BatchHistory() {
  const t = useT();
  const [tab, setTab] = useState<"history" | "analytics">("history");
  const { batches, source } = useBatches();
  const settings = useMemo(readAnalyticsSettings, []);
  const completed = batches.filter((batch) => batch.status === "Completed");
  // the batch in progress isn't finished yet: it doesn't count against the completion rate
  const finished = batches.filter((batch) => batch.status !== "In Progress");
  const completionRate = finished.length ? (completed.length / finished.length) * 100 : 0;
  const tested = batches.filter((batch) => batch.labResult === "Passed" || batch.labResult === "Failed");
  const passed = tested.filter((batch) => batch.labResult === "Passed");
  const labPassRate = tested.length ? (passed.length / tested.length) * 100 : null;
  // Lab-tested batches (Passed or Failed), oldest first, for the charts.
  const data = tested.map((batch) => ({ ...batch, short: batch.id.replace("B-2026-", "B-") })).reverse();
  const rangeRows = useMemo(() => buildRangeRows(tested, settings), [tested, settings]);
  // Means and ranges over the completed batches (every completed batch has a yield and a cost).
  const yieldOf = (list: BatchData[]) => meanAndRange(list.filter((batch) => batch.yield > 0).map((batch) => batch.yield));
  const costOf = (list: BatchData[]) =>
    meanAndRange(list.map((batch) => calculateCostPerLiter(batch, settings)).filter((cost): cost is number => cost !== null));
  const yieldAll = yieldOf(completed);
  const costAll = costOf(completed);
  const targetCost = settings.prices.diesel / 2;
  const costTone = !costAll ? "neutral" : costAll.mean < targetCost ? "green" : costAll.mean < settings.prices.diesel ? "yellow" : "red";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="section-kicker">{t("Production records")}</div>
          <Heading as="h1" className="mt-2 text-3xl font-bold tracking-tight">{t("Batch History")}</Heading>
          <p className="mt-2 text-sm text-gray-500">{t("Review production records, compare outcomes, and observe relationships in recorded batch data.")}</p>
        </div>
        <div className="flex rounded-lg border border-white/[0.08] bg-gv-inset p-1">
          <button onClick={() => setTab("history")} className={`rounded-md px-4 py-2 text-xs font-semibold transition-colors ${tab === "history" ? "bg-green-500 text-black" : "text-gray-500 hover:text-white"}`}>{t("History")}</button>
          <button onClick={() => setTab("analytics")} className={`rounded-md px-4 py-2 text-xs font-semibold transition-colors ${tab === "analytics" ? "bg-green-500 text-black" : "text-gray-500 hover:text-white"}`}>{t("Analytics")}</button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5"><Metric label={t("Total batches")} value={batches.length} sub={source === "offline" ? t("Raspberry Pi offline") : t("Raspberry Pi records")} /></Card>
        <Card className="p-5"><Metric label={t("Completion rate")} value={`${completionRate.toFixed(1)}%`} sub={t("{done} of {total} completed", { done: completed.length, total: finished.length })} accent /></Card>
        <Card className="p-5"><Metric label={t("Lab pass rate")} value={labPassRate === null ? "—" : `${labPassRate.toFixed(1)}%`} sub={tested.length ? t("{passed} of {tested} tested", { passed: passed.length, tested: tested.length }) : t("No lab results yet")} accent={labPassRate !== null} /></Card>
        <Card className="p-5"><Metric label={t("Mean yield")} value={formatStats(yieldAll, "%", "mean")} sub={yieldAll ? t("range {range} · {n} completed batches", { range: formatStats(yieldAll, "%", "range"), n: yieldAll.n }) : source === "offline" ? t("Raspberry Pi offline") : t("No completed batches yet")} /></Card>
      </div>

      {tab === "history" ? (
        <Card className="overflow-hidden">
          <div className="border-b border-white/[0.06] px-6 py-5">
            <Heading as="h2" className="text-lg font-semibold">{t("All batches")}</Heading>
            <p className="mt-1 text-xs text-gray-600">{source === "offline" ? t("The Raspberry Pi can't be reached: the batches show again when it is connected.") : t("Stored on the Raspberry Pi")}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="gv-table min-w-[980px]">
              <thead><tr><th>{t("Batch ID")}</th><th>{t("Date")}</th><th>{t("Oil Volume")}</th><th>{t("FFA %")}</th><th>{t("Biodiesel Yield")}</th><th>{t("Duration")}</th><th>{t("Status")}</th><th>{t("Lab Test")}</th><th>{t("Details")}</th></tr></thead>
              <tbody>
                {batches.length > 0 ? (
                  batches.map((batch) => {
                    // the batch in progress: no results yet, and it is continued on the Process page
                    const running = batch.status === "In Progress";
                    return (
                      <tr key={batch.id}>
                        <td className="font-mono !text-green-400">{batch.id}</td>
                        <td>{new Date(batch.date).toLocaleDateString()}</td>
                        <td>{batch.oilVolume ? `${batch.oilVolume.toLocaleString()} mL` : "—"}</td>
                        <td>{running && !batch.oilVolume ? "—" : <><div>{formatFfa(batch)}</div>{batch.esterificationRun && <div className="mt-1 text-[10px] text-gray-600">{t("Esterified")}{batch.esterificationStages && batch.esterificationStages.length > 1 ? ` · ${t("{count} stages", { count: batch.esterificationStages.length })}` : ""}</div>}</>}</td>
                        <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                        <td>{running ? "—" : `${batch.duration} min`}</td>
                        <td>
                          <Status tone={batchTone(batch.status)}>{t(batch.status)}</Status>
                          {running && <div className="mt-1 text-[10px] text-gray-600">{batch.currentStage ? t(batch.currentStage) : t("Starting")}</div>}
                        </td>
                        <td>{running ? "—" : <Status tone={batch.labResult === "Passed" ? "green" : batch.labResult === "Failed" ? "red" : batch.labResult === "Pending" ? "yellow" : "neutral"}>{t(batch.labResult)}</Status>}</td>
                        <td>
                          <div className="flex flex-col gap-1">
                            {running && <Link to="/process" className="font-medium text-blue-400 hover:text-blue-300">{t("Continue Process")} →</Link>}
                            <Link to={`/batches/${batch.id}`} className="font-medium text-green-400 hover:text-green-300">{t("View details")} →</Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })) : (
                    <tr>
                      <td colSpan={9} className="py-12 text-center">
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
      ) : (
        <div className="space-y-6">
          <Card className="p-6" data-testid="statistical-treatment">
            <div className="section-kicker">{t("Statistical treatment")}</div>
            <Heading as="h2" className="mt-2 text-xl font-semibold">{t("How the batch analytics are computed")}</Heading>
            <ul className="mt-4 space-y-2 text-sm leading-6 text-gray-400">
              <li>{t("Frequencies and percentages: completion rate = completed ÷ finished batches × 100; lab pass rate = Passed ÷ lab-tested batches × 100 (PNS for CME and ASTM D6751).")}</li>
              <li>{t("Means and ranges (minimum–maximum) per FFA range: yield = output load cell weight ÷ 0.88 g/mL ÷ oil volume × 100; cost per liter = materials used × Settings prices ÷ liters of biodiesel, compared with the target of half the diesel price.")}</li>
              <li>{t("Proven settings: at least {count} lab-tested batches with the same settings in the same FFA range, all Passed, every yield within ±{tolerance} percentage points of their mean.", { count: settings.provenBatchCount, tolerance: settings.provenYieldTolerance })}</li>
              <li>{t("No machine learning. The chart of FFA against yield shows association only, not causation.")}</li>
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-white/[0.06] p-6">
              <Heading as="h2" className="text-xl font-semibold">{t("Results per FFA Range")}</Heading>
              <p className="mt-1 text-xs text-gray-600">{t("Yield and cost: completed batches. Lab pass rate, recommended settings and status: lab-tested batches. Recommended = the settings with the highest mean yield among Passed batches.")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="gv-table min-w-[1250px]">
                <thead><tr><th>{t("FFA range")}</th><th>{t("Completed")}</th><th>{t("Lab pass rate")}</th><th>{t("Mean yield")}</th><th>{t("Yield range")}</th><th>{t("Mean cost per liter")}</th><th>{t("Cost range")}</th><th>{t("Recommended parameters")}</th><th>{t("Status")}</th></tr></thead>
                <tbody>
                  {rangeRows.map((row) => {
                    const done = completed.filter((batch) => inRange(batch.ffa, row.range));
                    const yields = yieldOf(done);
                    const costs = costOf(done);
                    return (
                      <tr key={row.range.key}>
                        <td className="font-medium !text-white">{t(row.range.label)}</td>
                        <td>{done.length}</td>
                        <td>{row.batches.length ? `${((row.passed.length / row.batches.length) * 100).toFixed(1)}% (${row.passed.length}/${row.batches.length})` : "—"}</td>
                        <td>{formatStats(yields, "%", "mean")}</td>
                        <td>{formatStats(yields, "%", "range")}</td>
                        <td>{formatStats(costs, "₱", "mean")}</td>
                        <td>{formatStats(costs, "₱", "range")}</td>
                        <td className="max-w-md leading-5">{parameterDescription(t, row.recommended)}</td>
                        <td><Status tone={row.status === "Proven" ? "green" : row.status === "Testing" ? "yellow" : "neutral"}>{t(row.status)}</Status></td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="font-semibold !text-white">{t("All batches")}</td>
                    <td>{completed.length}</td>
                    <td>{labPassRate === null ? "—" : `${labPassRate.toFixed(1)}% (${passed.length}/${tested.length})`}</td>
                    <td>{formatStats(yieldAll, "%", "mean")}</td>
                    <td>{formatStats(yieldAll, "%", "range")}</td>
                    <td>{formatStats(costAll, "₱", "mean")}</td>
                    <td>{formatStats(costAll, "₱", "range")}</td>
                    <td />
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <Heading as="h2" className="text-xl font-semibold">{t("Cost per Liter")}</Heading>
                <p className="mt-1 text-xs text-gray-600">{t("Materials used × Settings prices ÷ liters of biodiesel (completed batches)")}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div><div className="gv-label">{t("Mean cost")}</div><Status tone={costTone}>{costAll ? `₱${costAll.mean.toFixed(2)}/L` : "—"}</Status></div>
                <Metric label={t("Diesel price")} value={`₱${settings.prices.diesel.toFixed(2)}/L`} />
                <Metric label={t("Target")} value={`₱${targetCost.toFixed(2)}/L`} sub={t("Half of diesel price")} />
              </div>
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6">
              <Heading as="h2" className="text-lg font-semibold">{t("Yield per Batch")}</Heading>
              <p className="mt-1 text-xs text-gray-600">{t("Lab-tested batches; the lab result is shown by color and label")}</p>
              <div className="mt-6 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} margin={{ top: 22, bottom: 18 }}>
                    <CartesianGrid stroke={chartColors.grid} vertical={false} />
                    <XAxis dataKey="short" stroke={chartColors.text} fontSize={11} tick={(props) => {
                      const batch = data.find((item) => item.short === props.payload.value);
                      return <text x={props.x} y={Number(props.y) + 10} textAnchor="middle" fill={chartColors.text} fontSize={10}><tspan x={props.x}>{props.payload.value}</tspan><tspan x={props.x} dy="13" fill={batch?.labResult === "Passed" ? chartColors.green : chartColors.red}>{batch ? t(batch.labResult) : ""}</tspan></text>;
                    }} />
                    <YAxis domain={[0, 100]} stroke={chartColors.text} fontSize={11} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="yield" name="Yield" unit="%" radius={[5, 5, 0, 0]}>
                      {data.map((batch) => <Cell key={batch.id} fill={batch.labResult === "Passed" ? chartColors.green : chartColors.red} />)}
                      <LabelList dataKey="yield" position="top" fill={chartColors.label} fontSize={10} formatter={(value) => `${Number(value).toFixed(1)}%`} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="p-6">
              <Heading as="h2" className="text-lg font-semibold">{t("FFA % vs. Yield")}</Heading>
              <p className="mt-1 text-xs text-gray-600">{t("Starting FFA and yield of lab-tested batches (association only)")}</p>
              <div className="mt-5 h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart>
                    <CartesianGrid stroke={chartColors.grid} />
                    <XAxis type="number" dataKey="ffa" name="FFA" unit="%" stroke={chartColors.text} fontSize={10} />
                    <YAxis type="number" dataKey="yield" name="Yield" unit="%" domain={[0, 100]} stroke={chartColors.text} fontSize={10} />
                    <Tooltip content={<ChartTooltip />} />
                    <ReferenceLine x={4} stroke={chartColors.amber} strokeDasharray="5 5" label={{ value: t("Esterification cutoff"), fill: chartColors.amber, fontSize: 10, position: "insideTopRight" }} />
                    <Scatter data={data} shape={<ResultMarker />} />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <ResultLegend />
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
