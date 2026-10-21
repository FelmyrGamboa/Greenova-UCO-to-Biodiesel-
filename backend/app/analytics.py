"""Batch analytics, using exactly the same rules as the website's Batch History page
(buildRangeRows, calculateCostPerLiter) and getRecommendedParametersForFfa in greenovaData.ts,
so the website and the Pi always show the same numbers.

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
    tested = [b for b in batches if is_tested(b)]
    rows = []
    for r in ffa_ranges(s):
        in_r = [b for b in tested if in_range(b.ffa, r)]
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
        yields = [b.yield_ for b in in_r]
        rows.append({
            "range": r,
            "testedBatches": len(in_r),
            "passedBatches": len(passed),
            "labPassRate": len(passed) / len(in_r) * 100 if in_r else None,
            "recommendedBatchId": recommended.id if recommended else None,
            "recommendedParameters": parameters_of(recommended) if recommended else None,
            "esterificationRun": recommended.esterification_run if recommended else None,
            "averageYield": _mean(yields),
            "minimumYield": min(yields) if yields else None,
            "maximumYield": max(yields) if yields else None,
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
            + b.energy * m.electricity_price)
    return cost / (b.biodiesel_output_ml / 1000)


def cost_report(batches: list[Batch], s: Settings) -> dict:
    tested = [b for b in reversed(batches) if is_tested(b)]   # oldest first, like the website charts
    rows = [{"id": b.id, "costPerLiter": c} for b in tested if (c := cost_per_liter(b, s)) is not None]
    average = _mean([r["costPerLiter"] for r in rows])
    target = s.diesel_price / 2
    tone = ("neutral" if average is None else "green" if average < target
            else "yellow" if average < s.diesel_price else "red")
    return {"batches": rows, "averageCost": average, "dieselPrice": s.diesel_price,
            "targetCost": target, "tone": tone}


def summary(batches: list[Batch]) -> dict:
    completed = [b for b in batches if b.status == "Completed"]
    finished = [b for b in batches if b.status != "In Progress"]   # the ongoing batch isn't a failure
    tested = [b for b in batches if is_tested(b)]
    passed = [b for b in tested if b.lab_result == "Passed"]
    return {
        "totalBatches": len(batches),
        "completed": len(completed),
        "completionRate": len(completed) / len(finished) * 100 if finished else 0,
        "tested": len(tested),
        "passed": len(passed),
        "labPassRate": len(passed) / len(tested) * 100 if tested else None,
        "averageYield": sum(b.yield_ for b in completed) / max(len(completed), 1),
    }
