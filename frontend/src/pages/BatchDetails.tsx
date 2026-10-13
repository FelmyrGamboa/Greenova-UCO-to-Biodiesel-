import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, Card, Field, Heading, Metric, Status } from "../components/ui";
import { formatFfa, getBatches } from "../lib/greenovaData";
import { getBatch, isOffline, updateBatchLabResult, type BatchRecord } from "../lib/api";
import { useT } from "../lib/i18n";

const demoTimeline = [
  ["Start", "09:02 AM"],
  ["Preparation", "09:08 AM"],
  ["Volume & Parameters", "09:17 AM"],
  ["Oil Loading", "09:28 AM"],
  ["Reaction Started", "09:35 AM"],
  ["Reaction Completed", "10:35 AM"],
  ["Separation Started", "10:40 AM"],
  ["Dry Wash (Magnesol)", "11:02 AM"],
  ["Draining", "11:19 AM"],
  ["Complete", "11:16 AM"],
];

export default function BatchDetails() {
  const t = useT();
  const { batchId } = useParams();
  const [batch, setBatch] = useState<BatchRecord>(() => getBatches().find((item) => item.id === batchId) ?? getBatches()[0]);
  const [fromBackend, setFromBackend] = useState(false);
  const [labReference, setLabReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    getBatch(batchId)
      .then((found) => {
        if (cancelled || !found) return;
        setBatch(found);
        setFromBackend(Boolean(found.createdAt || found.timeline));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  async function recordLabResult(result: "Passed" | "Failed") {
    setError(null);
    try {
      const updated = await updateBatchLabResult(batch.id, result, labReference);
      if (updated) setBatch(updated);
    } catch (problem) {
      setError(isOffline(problem) ? t("Backend offline.") : t(problem instanceof Error ? problem.message : String(problem)));
    }
  }

  const timeline: Array<[string, string]> = batch.timeline?.length
    ? batch.timeline.map((event) => [t(event.label), new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })])
    : demoTimeline.map(([label, time]) => [t(label), time]);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/batches" className="text-sm text-gray-500 hover:text-green-400">← {t("Back to Batch History")}</Link>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="section-kicker">{t("Batch record")}</div>
            <Heading as="h1" className="mt-2 text-3xl font-bold">{batch.id}</Heading>
            <p className="mt-2 text-sm text-gray-500">{t("Completed {date}", { date: new Date(batch.date).toLocaleDateString() })} · {fromBackend ? t("Raspberry Pi record") : t("Prototype record")}</p>
          </div>
          <Status tone={batch.status === "Completed" ? "green" : "red"}>{t(batch.status)}</Status>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5"><Metric label={t("Oil volume")} value={`${batch.oilVolume.toLocaleString()} mL`} /></Card>
        <Card className="p-5"><Metric label={t("Biodiesel yield")} value={batch.yield ? `${batch.yield}%` : "—"} accent /></Card>
        <Card className="p-5"><Metric label={t("Process duration")} value={`${batch.duration} min`} /></Card>
        <Card className="p-5"><Metric label={t("Energy used")} value={`${batch.energy} kWh`} /></Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-[0.75fr_1.25fr]">
        <Card className="p-6">
          <Heading as="h2" className="text-lg font-semibold">{t("Process Parameters")}</Heading>
          <div className="mt-6 space-y-5">
            <Metric label={t("Starting FFA")} value={formatFfa(batch)} sub={batch.ffaAboveStrip ? t("The strip showed its darkest color") : t("Test strip")} />
            {batch.esterificationRun && (
              <Metric
                label={t("Esterification")}
                value={batch.esterificationStages?.length ? t("{count} stages", { count: batch.esterificationStages.length }) : t("Run")}
                sub={batch.esterificationStages?.length
                  ? `FFA ${[formatFfa(batch), ...batch.esterificationStages.map((stage) => formatFfa({ ffa: stage.ffaAfter ?? 0 }))].join(" → ")}`
                  : undefined}
              />
            )}
            <Metric label={t("Temperature")} value={`${batch.temperature} °C`} />
            <Metric label={t("Reaction time")} value={`${batch.reactionTime} min`} />
            <Metric label={t("Stirring speed")} value={`${batch.stirringSpeed} RPM`} />
            {batch.current ? <Metric label={t("Current setting")} value={`${batch.current} A`} /> : null}
            {(batch.purification?.adsorbentG ?? batch.purification?.magnesolG) ? (
              <Metric
                label={t((batch.adsorbent ?? batch.purification?.adsorbent) === "Bentonite" ? "Bentonite (dry wash)" : "Magnesol (dry wash)")}
                value={`${(batch.purification?.adsorbentG ?? batch.purification?.magnesolG ?? 0).toFixed(1)} g`}
              />
            ) : null}
            {batch.biodieselOutputMl ? (
              <Metric label={t("Biodiesel output")} value={`${batch.biodieselOutputMl.toFixed(1)} mL`} sub={batch.purification?.outputWeightG ? t("{grams} g on the output load cell", { grams: batch.purification.outputWeightG.toFixed(1) }) : undefined} />
            ) : null}
            <div><div className="gv-label">{t("Lab test")}</div><Status tone={batch.labResult === "Passed" ? "green" : batch.labResult === "Failed" ? "red" : batch.labResult === "Pending" ? "yellow" : "neutral"}>{t(batch.labResult)}</Status></div>
            {batch.labReference && <Metric label={t("Lab reference no.")} value={batch.labReference} />}
          </div>
        </Card>
        <Card className="p-6">
          <Heading as="h2" className="text-lg font-semibold">{t("Batch Timeline")}</Heading>
          <div className="mt-6">
            {timeline.map(([label, time], index) => (
              <div key={`${index}-${label}`} className="relative flex gap-4 pb-6 last:pb-0">
                {index < timeline.length - 1 && <div className="absolute left-[7px] top-4 h-full w-px bg-green-500/20" />}
                <div className="relative z-10 mt-1 h-4 w-4 rounded-full border-2 border-gv-surface bg-green-500" />
                <div className="flex flex-1 items-center justify-between gap-4">
                  <div className="text-sm font-medium text-gray-300">{label}</div>
                  <div className="font-mono text-xs text-gray-600">{time}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
      {batch.labResult === "Pending" && (
        <Card className="p-6">
          <Heading as="h2" className="text-lg font-semibold">{t("Record lab result")}</Heading>
          <p className="mt-1 text-sm text-gray-500">{t("Update this batch when the laboratory certificate arrives.")}</p>
          <div className="mt-5 max-w-md">
            <Field label={t("Lab reference no. (optional)")} value={labReference} onChange={(event) => setLabReference(event.target.value)} />
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => recordLabResult("Passed")}>{t("Passed")}</Button>
            <Button variant="danger" onClick={() => recordLabResult("Failed")}>{t("Failed")}</Button>
          </div>
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </Card>
      )}
    </div>
  );
}
