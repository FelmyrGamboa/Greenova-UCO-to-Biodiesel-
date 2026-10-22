"""Batch analytics, using exactly the same rules as the website's Batch History page
(buildRangeRows, calculateCostPerLiter, meanAndRange) and getRecommendedParametersForFfa in
greenovaData.ts, so the website and the Pi always show the same numbers.

Statistical treatment (the thesis' evaluation): frequencies and percentages for the completion
and lab pass rates; means and ranges (minimum-maximum) for yield, energy and cost per liter, per
FFA range and overall. No machine learning.

- Only batches with a Passed or Failed lab result count as tested.
- FFA ranges come from ffaRangeBoundaries: a batch is in a range when min <= FFA < max.
- The recommended parameters for a range are those of the parameter group with the highest
  average yield among its Passed batches.
- A range is "Proven" when the recommended group has at least provenBatchCount tested batches,
  all Passed, each within provenYieldTolerance points of the group's average yield.
"""
from typing import Optional

from .models import Batch, Settings


def is_tested(b: Batch) -> bool:
    return b.lab_result in ("Passed", "Failed")


def _mean(values: list[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def mean_and_range(values: list[float]) -> Optional[dict]:
    """n, mean, minimum and maximum (None for no values): the statistic shown for yield and cost."""
    if not values:
        return None
    return {"n": len(values), "mean": sum(values) / len(values), "min": min(values), "max": max(values)}


def _completed(batches: list[Batch]) -> list[Batch]:
    return [b for b in batches if b.status == "Completed"]


def yield_stats(batches: list[Batch]) -> Optional[dict]:
    """Mean and range of the yield of the completed batches (a batch without output is left out)."""
    return mean_and_range([b.yield_ for b in _completed(batches) if b.yield_ > 0])


def energy_stats(batches: list[Batch]) -> Optional[dict]:
    """Mean and range of the energy used (kWh) by the completed batches that have it."""
    return mean_and_range([b.energy for b in _completed(batches) if b.energy and b.energy > 0])


def cost_stats(batches: list[Batch], s: Settings) -> Optional[dict]:
    """Mean and range of the cost per liter of the completed batches."""
    return mean_and_range([c for b in _completed(batches) if (c := cost_per_liter(b, s)) is not None])


def ffa_ranges(s: Settings) -> list[dict]:
    bounds = s.boundaries()
    ranges = []
    for lo, hi in zip(bounds, bounds[1:]):
        if lo == 0 and hi == 4:
            label = "0–3% — straight to transesterification"
        elif lo == 4 and hi == 5:
            label = "4% — esterified"
        else:
            label = f"{lo:g}–{hi - 1:g}%"
        ranges.append({"key": f"{lo:g}-{hi:g}", "label": label, "min": lo, "max": hi})
    last = bounds[-1]
    ranges.append({"key": f"{last:g}+", "label": f"{last:g}%+ — esterified", "min": last, "max": None})
    return ranges


def in_range(ffa: float, r: dict) -> bool:
    return ffa >= r["min"] and (r["max"] is None or ffa < r["max"])


def signature(b: Batch) -> tuple:
    """The settings a batch ran with (same as parameterSignature on the website)."""
    ester = b.esterification_run
    return (
        (b.esterification_voltage if b.esterification_voltage is not None else 20) if ester else "none",
        (b.esterification_time if b.esterification_time is not None else 120) if ester else "none",
        (b.esterification_stirring if b.esterification_stirring is not None else 500) if ester else "none",
        b.voltage if b.voltage is not None else 30,
        b.reaction_time,
        b.stirring_speed,
        b.methanol_ratio if b.methanol_ratio is not None else 7,
    )


def parameters_of(b: Batch) -> dict:
    """Same keys as getRecommendedParametersForFfa on the website. The esterification keys are
    left out when the batch skipped esterification, like the website's undefined values."""
    ester = {}
    if b.esterification_run:
        ester = {"esterificationVoltage": b.esterification_voltage,
                 "esterificationTime": b.esterification_time,
                 "esterificationStirring": b.esterification_stirring}
    return {
        **ester,
        "transesterificationVoltage": b.voltage if b.voltage is not None else 30,
        "transesterificationTime": b.reaction_time,
        "transesterificationStirring": b.stirring_speed,
        "methanolRatio": b.methanol_ratio if b.methanol_ratio is not None else 7,
    }


def _best_group(passed: list[Batch]) -> Optional[tuple]:
    groups: dict[tuple, list[Batch]] = {}
    for b in passed:
        groups.setdefault(signature(b), []).append(b)
    ranked = sorted(((sig, group, _mean([b.yield_ for b in group])) for sig, group in groups.items()),
                    key=lambda item: -item[2])   # stable: ties keep the first group, like the website
    return ranked[0] if ranked else None


def range_rows(batches: list[Batch], s: Settings) -> list[dict]:
    """Per FFA range: lab pass rate, recommended settings and status from the lab-tested batches;
    yield and cost (mean and range) from the completed batches."""
    tested = [b for b in batches if is_tested(b)]
    rows = []
    for r in ffa_ranges(s):
        in_r = [b for b in tested if in_range(b.ffa, r)]
        done = [b for b in _completed(batches) if in_range(b.ffa, r)]
        passed = [b for b in in_r if b.lab_result == "Passed"]
        best = _best_group(passed)
        recommended, proven = None, False
        if best:
            sig, group, average = best
            recommended = group[0]
            matching = [b for b in in_r if signature(b) == sig]
            proven = (len(matching) >= s.proven_batch_count
                      and all(b.lab_result == "Passed" for b in matching)
                      and all(abs(b.yield_ - average) <= s.proven_yield_tolerance for b in matching))
        yields = yield_stats(done)
        rows.append({
            "range": r,
            "completedBatches": len(done),
            "testedBatches": len(in_r),
            "passedBatches": len(passed),
            "labPassRate": len(passed) / len(in_r) * 100 if in_r else None,
            "recommendedBatchId": recommended.id if recommended else None,
            "recommendedParameters": parameters_of(recommended) if recommended else None,
            "esterificationRun": recommended.esterification_run if recommended else None,
            "yield": yields,
            "averageYield": yields["mean"] if yields else None,
            "minimumYield": yields["min"] if yields else None,
            "maximumYield": yields["max"] if yields else None,
            "energyKwh": energy_stats(done),
            "costPerLiter": cost_stats(done, s),
            "status": "No data" if not in_r else "Proven" if proven else "Testing",
        })
    return rows


def recommended_parameters(ffa: float, batches: list[Batch], s: Settings) -> Optional[dict]:
    """Parameters the Volume & Parameters step loads for a new batch, or None to keep the defaults
    (same as getRecommendedParametersForFfa)."""
    bounds = s.boundaries()
    index = next((i for i, lo in enumerate(bounds)
                  if ffa >= lo and (i + 1 >= len(bounds) or ffa < bounds[i + 1])), 0)
    lo = bounds[index]
    hi = bounds[index + 1] if index + 1 < len(bounds) else None
    passed = [b for b in batches if b.lab_result == "Passed" and b.ffa >= lo and (hi is None or b.ffa < hi)]
    best = _best_group(passed)
    return parameters_of(best[1][0]) if best else None


def cost_per_liter(b: Batch, s: Settings) -> Optional[float]:
    """(Σ(material used × its price) + energy used × electricity price) ÷ liters of biodiesel."""
    if b.materials is None or not b.biodiesel_output_ml or b.biodiesel_output_ml <= 0:
        return None
    m = s
    catalyst_price = m.koh_price if b.catalyst_type == "KOH" else m.naoh_price
    cost = (b.materials.oil_l * m.oil_price
            + b.materials.methanol_l * m.methanol_price
            + b.materials.catalyst_kg * catalyst_price
            + b.materials.sulfuric_acid_l * m.sulfuric_acid_price
            + b.materials.acetone_l * m.acetone_price
            + b.materials.bentonite_kg * m.bentonite_price
            + b.materials.magnesol_kg * m.magnesol_price
            + (b.energy or 0) * m.electricity_price)
    return cost / (b.biodiesel_output_ml / 1000)


def cost_report(batches: list[Batch], s: Settings) -> dict:
    """Cost per liter of the completed batches (oldest first), its mean and range, and the target
    (half the diesel price)."""
    done = list(reversed(_completed(batches)))
    rows = [{"id": b.id, "costPerLiter": c} for b in done if (c := cost_per_liter(b, s)) is not None]
    stats = mean_and_range([r["costPerLiter"] for r in rows])
    average = stats["mean"] if stats else None
    target = s.diesel_price / 2
    tone = ("neutral" if average is None else "green" if average < target
            else "yellow" if average < s.diesel_price else "red")
    return {"batches": rows, "averageCost": average, "minimumCost": stats["min"] if stats else None,
            "maximumCost": stats["max"] if stats else None, "dieselPrice": s.diesel_price,
            "targetCost": target, "tone": tone}


def summary(batches: list[Batch]) -> dict:
    completed = [b for b in batches if b.status == "Completed"]
    finished = [b for b in batches if b.status != "In Progress"]   # the ongoing batch isn't a failure
    tested = [b for b in batches if is_tested(b)]
    passed = [b for b in tested if b.lab_result == "Passed"]
    yields = yield_stats(batches)
    return {
        "totalBatches": len(batches),
        "completed": len(completed),
        "completionRate": len(completed) / len(finished) * 100 if finished else 0,
        "tested": len(tested),
        "passed": len(passed),
        "labPassRate": len(passed) / len(tested) * 100 if tested else None,
        "averageYield": yields["mean"] if yields else 0,
        "minimumYield": yields["min"] if yields else None,
        "maximumYield": yields["max"] if yields else None,
        "energyKwh": energy_stats(batches),
    }
