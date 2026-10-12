import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, Heading, Metric, SelectField, Status } from "../components/ui";
import { ffaBoundaries, formatFfa, type DemoBatch } from "../lib/greenovaData";
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
    electricity: number;
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
      electricity: numberValue("electricityPrice", 12),
      diesel: numberValue("dieselPrice", 55),
    },
  };
}

function inRange(ffa: number, range: FfaRange) {
  return ffa >= range.min && (range.max === null || ffa < range.max);
}

function parameterSignature(batch: DemoBatch) {
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

function parameterDescription(t: TFunction, batch?: DemoBatch) {
  if (!batch) return t("Using defaults");
  const esterification = batch.esterificationRun
    ? `${t("Esterification")} ${batch.esterificationVoltage ?? 20} V · ${batch.esterificationTime ?? 120} min · ${batch.esterificationStirring ?? 500} RPM · ${t("2 stages")}`
    : t("Esterification skipped · 1 stage");
  return `${esterification}; ${t("Transesterification")} ${batch.voltage ?? 30} V · ${batch.reactionTime} min · ${batch.stirringSpeed} RPM · ${batch.methanolRatio ?? 7}:1`;
}

function buildRangeRows(tested: DemoBatch[], settings: AnalyticsSettings) {
  return settings.ranges.map((range) => {
    const rangeBatches = tested.filter((batch) => inRange(batch.ffa, range));
    const passed = rangeBatches.filter((batch) => batch.labResult === "Passed");
    const groups = new Map<string, DemoBatch[]>();
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

function calculateCostPerLiter(batch: DemoBatch, settings: AnalyticsSettings) {
  if (!batch.materials || !batch.biodieselOutputMl || batch.biodieselOutputMl <= 0) return null;
  const materialCost =
    batch.materials.oilL * settings.prices.oil +
    batch.materials.methanolL * settings.prices.methanol +
    batch.materials.catalystKg * (batch.catalystType === "KOH" ? settings.prices.koh : settings.prices.naoh) +
    batch.materials.sulfuricAcidL * settings.prices.sulfuricAcid +
    batch.materials.acetoneL * settings.prices.acetone +
    batch.materials.bentoniteKg * settings.prices.bentonite +
    batch.energy * settings.prices.electricity;
  return materialCost / (batch.biodieselOutputMl / 1000);
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; unit?: string; payload?: DemoBatch }>;
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

function ResultMarker(props: { cx?: number; cy?: number; payload?: DemoBatch }) {
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
  const completionRate = batches.length ? (completed.length / batches.length) * 100 : 0;
  const tested = batches.filter((batch) => batch.labResult === "Passed" || batch.labResult === "Failed");
  const passed = tested.filter((batch) => batch.labResult === "Passed");
  const labPassRate = tested.length ? (passed.length / tested.length) * 100 : null;
  const data = tested.map((batch) => ({
    ...batch,
    short: batch.id.replace("B-2026-", "B-"),
    biodieselLiters: (batch.biodieselOutputMl || 0) / 1000,
    energyPerLiter: batch.biodieselOutputMl ? batch.energy / (batch.biodieselOutputMl / 1000) : 0,
  })).reverse();
  const rangeRows = useMemo(() => buildRangeRows(tested, settings), [tested, settings]);
  const defaultRange = [...rangeRows].sort((a, b) => b.batches.length - a.batches.length)[0]?.range.key || settings.ranges[0].key;
  const [selectedRangeKey, setSelectedRangeKey] = useState(defaultRange);
  const selectedRange = settings.ranges.find((range) => range.key === selectedRangeKey) || settings.ranges[0];
  const filteredData = data.filter((batch) => inRange(batch.ffa, selectedRange));
  const costData = data
    .map((batch) => ({ ...batch, costPerLiter: calculateCostPerLiter(batch, settings) }))
    .filter((batch): batch is typeof batch & { costPerLiter: number } => batch.costPerLiter !== null);
  const averageCost = costData.length ? costData.reduce((sum, batch) => sum + batch.costPerLiter, 0) / costData.length : null;
  const targetCost = settings.prices.diesel / 2;
  const costTone = averageCost === null ? "neutral" : averageCost < targetCost ? "green" : averageCost < settings.prices.diesel ? "yellow" : "red";

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
        <Card className="p-5"><Metric label={t("Total batches")} value={batches.length} sub={source === "backend" ? t("Raspberry Pi records") : t("Sample prototype data")} /></Card>
        <Card className="p-5"><Metric label={t("Completion rate")} value={`${completionRate.toFixed(1)}%`} sub={t("{done} of {total} completed", { done: completed.length, total: batches.length })} accent /></Card>
        <Card className="p-5"><Metric label={t("Lab pass rate")} value={labPassRate === null ? "—" : `${labPassRate.toFixed(1)}%`} sub={tested.length ? t("{passed} of {tested} tested", { passed: passed.length, tested: tested.length }) : t("No lab results yet")} accent={labPassRate !== null} /></Card>
        <Card className="p-5"><Metric label={t("Average yield")} value={`${(completed.reduce((sum, item) => sum + item.yield, 0) / Math.max(completed.length, 1)).toFixed(1)}%`} sub={source === "backend" ? t("Raspberry Pi records") : t("Sample prototype data")} /></Card>
      </div>

      {tab === "history" ? (
        <Card className="overflow-hidden">
          <div className="border-b border-white/[0.06] px-6 py-5">
            <Heading as="h2" className="text-lg font-semibold">{t("All batches")}</Heading>
            <p className="mt-1 text-xs text-gray-600">{source === "backend" ? t("Stored on the Raspberry Pi") : t("Locally stored prototype records")}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="gv-table min-w-[1080px]">
              <thead><tr><th>{t("Batch ID")}</th><th>{t("Date")}</th><th>{t("Oil Volume")}</th><th>{t("FFA %")}</th><th>{t("Biodiesel Yield")}</th><th>{t("Duration")}</th><th>{t("Energy Used")}</th><th>{t("Status")}</th><th>{t("Lab Test")}</th><th>{t("Details")}</th></tr></thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="font-mono !text-green-400">{batch.id}</td>
                    <td>{new Date(batch.date).toLocaleDateString()}</td>
                    <td>{batch.oilVolume.toLocaleString()} mL</td>
                    <td><div>{formatFfa(batch)}</div>{batch.esterificationRun && <div className="mt-1 text-[10px] text-gray-600">{t("Esterified")}{batch.esterificationStages && batch.esterificationStages.length > 1 ? ` · ${t("{count} stages", { count: batch.esterificationStages.length })}` : ""}</div>}</td>
                    <td>{batch.yield ? `${batch.yield}%` : "—"}</td>
                    <td>{batch.duration} min</td>
                    <td>{batch.energy} kWh</td>
                    <td><Status tone={batch.status === "Completed" ? "green" : batch.status === "In Progress" ? "blue" : batch.status === "Cancelled" ? "yellow" : "red"}>{t(batch.status)}</Status></td>
                    <td><Status tone={batch.labResult === "Passed" ? "green" : batch.labResult === "Failed" ? "red" : batch.labResult === "Pending" ? "yellow" : "neutral"}>{t(batch.labResult)}</Status></td>
                    <td><Link to={`/batches/${batch.id}`} className="font-medium text-green-400 hover:text-green-300">{t("View details")} →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="border-b border-white/[0.06] p-6">
              <div className="section-kicker">{t("Tested batches only")}</div>
              <Heading as="h2" className="mt-2 text-xl font-semibold">{t("Best Parameters per FFA Range")}</Heading>
              <p className="mt-1 text-xs text-gray-600">{t("Recommendations use the highest average yield among Passed batches")}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="gv-table min-w-[1250px]">
                <thead><tr><th>{t("FFA range")}</th><th>{t("Tested batches")}</th><th>{t("Lab pass rate")}</th><th>{t("Recommended parameters")}</th><th>{t("Average yield")}</th><th>{t("Yield spread")}</th><th>{t("Status")}</th></tr></thead>
                <tbody>
                  {rangeRows.map((row) => (
                    <tr key={row.range.key}>
                      <td className="font-medium !text-white">{t(row.range.label)}</td>
                      <td>{row.batches.length}</td>
                      <td>{row.batches.length ? `${((row.passed.length / row.batches.length) * 100).toFixed(1)}%` : "—"}</td>
                      <td className="max-w-md leading-5">{parameterDescription(t, row.recommended)}</td>
                      <td>{row.averageYield === null ? "—" : `${row.averageYield.toFixed(1)}%`}</td>
                      <td>{row.minimumYield === null ? "—" : `${row.minimumYield.toFixed(1)}–${row.maximumYield?.toFixed(1)}%`}</td>
                      <td><Status tone={row.status === "Proven" ? "green" : row.status === "Testing" ? "yellow" : "neutral"}>{t(row.status)}</Status></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card className="p-6">
              <Heading as="h2" className="text-lg font-semibold">{t("Yield Comparison")}</Heading>
              <p className="mt-1 text-xs text-gray-600">{t("Lab result shown by color and label")}</p>
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
              <p className="mt-1 text-xs text-gray-600">{t("Starting FFA and tested yield")}</p>
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

          <Card className="p-6">
            <Heading as="h2" className="text-lg font-semibold">{t("Energy and Processing Time")}</Heading>
            <p className="mt-1 text-xs text-gray-600">{t("Normalized energy and total process duration")}</p>
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              {[
                { title: "Energy per liter (kWh/L)", key: "energyPerLiter", color: chartColors.green, unit: " kWh/L" },
                { title: "Processing time (min)", key: "duration", color: chartColors.blue, unit: " min" },
              ].map((chart) => (
                <div key={chart.key} className="rounded-xl border border-white/[0.06] bg-gv-inset p-4">
                  <div className="text-sm font-semibold text-gray-300">{t(chart.title)}</div>
                  <div className="mt-3 h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data}>
                        <CartesianGrid stroke={chartColors.grid} vertical={false} />
                        <XAxis dataKey="short" stroke={chartColors.text} fontSize={10} />
                        <YAxis domain={[0, "auto"]} stroke={chartColors.text} fontSize={10} />
                        <Tooltip content={<ChartTooltip />} />
                        <Line type="monotone" dataKey={chart.key} name={chart.title} unit={chart.unit} stroke={chart.color} strokeWidth={2} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="max-w-3xl">
                <div className="section-kicker">{t("Batch data analysis")}</div>
                <Heading as="h2" className="mt-2 text-xl font-semibold">{t("Observed Batch Correlations")}</Heading>
                <p className="mt-2 text-sm leading-6 text-gray-500">{t("These charts show association only and do not establish scientific causation.")}</p>
              </div>
              <div className="w-full sm:w-48">
                <SelectField label={t("FFA range")} value={selectedRangeKey} onChange={(event) => setSelectedRangeKey(event.target.value)}>
                  {settings.ranges.map((range) => <option key={range.key} value={range.key}>{t(range.label)}</option>)}
                </SelectField>
              </div>
            </div>
            <div className="mt-7 grid gap-6 lg:grid-cols-3">
              {[
                { title: "Reaction time vs. yield", x: "reactionTime", xName: "Reaction time", unit: " min" },
                { title: "Voltage vs. yield", x: "voltage", xName: "Voltage", unit: " V" },
                { title: "Stirring speed vs. yield", x: "stirringSpeed", xName: "Stirring speed", unit: " RPM" },
              ].map((chart) => (
                <div key={chart.title} className="rounded-xl border border-white/[0.06] bg-gv-inset p-4">
                  <div className="text-sm font-semibold text-gray-300">{t(chart.title)}</div>
                  <div className="mt-3 h-52">
                    <ResponsiveContainer width="100%" height="100%">
                      <ScatterChart>
                        <CartesianGrid stroke={chartColors.grid} />
                        <XAxis type="number" dataKey={chart.x} name={chart.xName} unit={chart.unit} stroke={chartColors.text} fontSize={10} />
                        <YAxis type="number" dataKey="yield" name="Yield" domain={[0, 100]} stroke={chartColors.text} fontSize={10} />
                        <Tooltip content={<ChartTooltip />} />
                        <Scatter data={filteredData} shape={<ResultMarker />} />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                  <ResultLegend />
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="section-kicker">{t("Tested batches only")}</div>
                <Heading as="h2" className="mt-2 text-xl font-semibold">{t("Cost per Liter")}</Heading>
                <p className="mt-1 text-xs text-gray-600">{t("Recorded materials and configured Settings prices")}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div><div className="gv-label">{t("Average cost")}</div><Status tone={costTone}>{averageCost === null ? "—" : `₱${averageCost.toFixed(2)}/L`}</Status></div>
                <Metric label={t("Diesel price")} value={`₱${settings.prices.diesel.toFixed(2)}/L`} />
                <Metric label={t("Target")} value={`₱${targetCost.toFixed(2)}/L`} sub={t("Half of diesel price")} />
              </div>
            </div>
            <div className="mt-6 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={costData}>
                  <CartesianGrid stroke={chartColors.grid} vertical={false} />
                  <XAxis dataKey="short" stroke={chartColors.text} fontSize={10} />
                  <YAxis domain={[0, "auto"]} stroke={chartColors.text} fontSize={10} />
                  <Tooltip content={<ChartTooltip />} />
                  <ReferenceLine y={targetCost} stroke={chartColors.green} strokeDasharray="4 4" />
                  <ReferenceLine y={settings.prices.diesel} stroke={chartColors.red} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="costPerLiter" name="Cost per liter" unit=" ₱/L" stroke={chartColors.amber} strokeWidth={2} dot={{ fill: chartColors.amber }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
