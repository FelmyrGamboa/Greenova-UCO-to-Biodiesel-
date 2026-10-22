import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { batchTone, Button, Card, Field, Heading, Metric, Status } from "../components/ui";
import { formatFfa } from "../lib/greenovaData";
import { ApiError, getBatch, isOffline, updateBatchLabResult, type BatchRecord } from "../lib/api";
import { useT } from "../lib/i18n";

export default function BatchDetails() {
  const t = useT();
  const { batchId } = useParams();
  // The batch from the Raspberry Pi (null until it answers).
  const [batch, setBatch] = useState<BatchRecord | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "loaded" | "missing" | "offline">("loading");
  const [labReference, setLabReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A recorded result (Passed or Failed) can be changed: the same lab result is updated.
  const [changingLab, setChangingLab] = useState(false);
  const [savingLab, setSavingLab] = useState(false);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    let retry: number | undefined;
    const load = () =>
      getBatch(batchId)
        .then((found) => {
          if (cancelled) return;
          setBatch(found ?? null);
          setLoadState(found ? "loaded" : "missing");
        })
        .catch((problem) => {
          if (cancelled) return;
          if (problem instanceof ApiError && problem.status === 404) {
            setLoadState("missing");
          } else {
            setLoadState("offline");
            retry = window.setTimeout(load, 5000);   // the Pi may come back
          }
        });
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [batchId]);

  if (!batch) {
    return (
      <div className="space-y-6">
        <Link to="/batches" className="text-sm text-gray-500 hover:text-green-400">← {t("Back to Batch History")}</Link>
        <Card className="p-8 text-center text-sm text-gray-500">
          {loadState === "missing"
            ? t("Batch {id} was not found on the Raspberry Pi.", { id: batchId ?? "" })
            : loadState === "offline"
              ? t("The Raspberry Pi can't be reached. Check that it is on and on the same network, and that the Greenova service is running.")
              : t("Loading the batch…")}
        </Card>
      </div>
    );
  }

  async function recordLabResult(result: "Passed" | "Failed") {
    if (!batch) return;
    setError(null);
    setSavingLab(true);
    try {
      const updated = await updateBatchLabResult(batch.id, result, labReference);
      if (updated) setBatch(updated);
      setChangingLab(false);
      setLabReference("");
    } catch (problem) {
      setError(isOffline(problem) ? t("The Raspberry Pi is offline: the lab result was not saved.") : t(problem instanceof Error ? problem.message : String(problem)));
    } finally {
      setSavingLab(false);
    }
  }

  const tested = batch.labResult === "Passed" || batch.labResult === "Failed";
  const showLabForm = batch.status === "Completed" && (batch.labResult === "Pending" || changingLab);

  const running = batch.status === "In Progress";
  const timeline: Array<[string, string]> = (batch.timeline ?? []).map((event) =>
    [t(event.label), new Date(event.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })]);

  return (
    <div className="space-y-6">
      <div>
        <Link to="/batches" className="text-sm text-gray-500 hover:text-green-400">← {t("Back to Batch History")}</Link>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="section-kicker">{t("Batch record")}</div>
            <Heading as="h1" className="mt-2 text-3xl font-bold">{batch.id}</Heading>
            <p className="mt-2 text-sm text-gray-500">{t(running ? "Started {date}" : "Completed {date}", { date: new Date(batch.date).toLocaleDateString() })} · {t("Raspberry Pi record")}</p>
          </div>
          <Status tone={batchTone(batch.status)}>{t(batch.status)}{running && batch.currentStage ? ` · ${t(batch.currentStage)}` : ""}</Status>
        </div>
      </div>
      {running && (
        <Card className="flex flex-col gap-4 border-blue-500/20 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Heading as="h2" className="text-lg font-semibold">{t("This batch is in progress")}</Heading>
            <p className="mt-1 text-sm text-gray-500">{t("Its results are recorded when it is completed. Only one batch can be processed at a time.")}</p>
          </div>
          <Link to="/process" className="btn-primary">{t("Continue Process")} →</Link>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5"><Metric label={t("Oil volume")} value={`${batch.oilVolume.toLocaleString()} mL`} /></Card>
        <Card className="p-5"><Metric label={t("Biodiesel yield")} value={batch.yield ? `${batch.yield}%` : "—"} accent /></Card>
        <Card className="p-5"><Metric label={t("Process duration")} value={`${batch.duration} min`} /></Card>
        <Card className="p-5"><Metric label={t("Energy used")} value={batch.energy ? `${batch.energy.toFixed(3)} kWh` : "—"} sub={t("Power × time on of each part (see the timeline)")} /></Card>
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
            <div>
              <div className="gv-label">{t("Lab test")}</div>
              <Status tone={batch.labResult === "Passed" ? "green" : batch.labResult === "Failed" ? "red" : batch.labResult === "Pending" ? "yellow" : "neutral"}>{t(batch.labResult)}</Status>
              {tested && batch.labTestedAt && (
                <div className="mt-1 text-xs text-gray-500">{t("Recorded {time}", { time: new Date(batch.labTestedAt).toLocaleString() })}</div>
              )}
              {tested && batch.status === "Completed" && !changingLab && (
                <button type="button" className="mt-2 block text-xs font-medium text-green-400 hover:text-green-300" onClick={() => setChangingLab(true)}>{t("Change lab result")}</button>
              )}
            </div>
            {batch.labReference && <Metric label={t("Lab reference no.")} value={batch.labReference} />}
          </div>
        </Card>
        <Card className="p-6">
          <Heading as="h2" className="text-lg font-semibold">{t("Batch Timeline")}</Heading>
          <div className="mt-6">
            {timeline.length === 0 && <p className="text-sm text-gray-500">{t("No timeline events recorded for this batch.")}</p>}
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
      {showLabForm && (
        <Card className="p-6">
          <Heading as="h2" className="text-lg font-semibold">{changingLab ? t("Change lab result") : t("Record lab result")}</Heading>
          <p className="mt-1 text-sm text-gray-500">
            {changingLab
              ? t("The batch's lab result is updated (it stays one record). Leave the reference empty to keep {reference}.", { reference: batch.labReference || "—" })
              : t("Update this batch when the laboratory certificate arrives.")}
          </p>
          <div className="mt-5 max-w-md">
            <Field label={t("Lab reference no. (optional)")} value={labReference} onChange={(event) => setLabReference(event.target.value)} />
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button disabled={savingLab} onClick={() => recordLabResult("Passed")}>{t("Passed")}</Button>
            <Button variant="danger" disabled={savingLab} onClick={() => recordLabResult("Failed")}>{t("Failed")}</Button>
            {changingLab && <Button variant="ghost" onClick={() => { setChangingLab(false); setError(null); }}>{t("Cancel")}</Button>}
          </div>
          {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        </Card>
      )}
    </div>
  );
}
