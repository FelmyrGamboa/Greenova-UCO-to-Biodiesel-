"""Loads the same sample batches as the website (demoBatches + hydrateAnalyticsData in
src/lib/greenovaData.ts), so the backend and the website show identical numbers.

Run:  python -m app.seed          (only if the database has no batches yet)
      python -m app.seed --force  (add them anyway, replacing batches with the same IDs)
"""
import sys

from . import db
from .models import Batch, Materials

# Same rows as demoBatches on the website. FFA is a whole percent; FFA <= 1% goes straight to
# transesterification, anything higher is esterified first. ffaAboveStrip: the strip showed its
# darkest color (FFA 5% or more), recorded as 5.
DEMO_BATCHES = [
    dict(id="B-2026-024", date="2026-10-18", oilVolume=1000, ffa=1, esterificationRun=False, yield_=88.4, duration=132, energy=1.84, status="Completed", labResult="Passed", temperature=42, reactionTime=58, stirringSpeed=450),
    dict(id="B-2026-023", date="2026-10-16", oilVolume=1000, ffa=5.0, ffaAboveStrip=True, esterificationRun=True, yield_=86.9, duration=138, energy=1.91, status="Completed", labResult="Pending", temperature=41, reactionTime=62, stirringSpeed=440),
    dict(id="B-2026-022", date="2026-10-12", oilVolume=1200, ffa=1, esterificationRun=False, yield_=89.1, duration=147, energy=2.16, status="Completed", labResult="Passed", temperature=43, reactionTime=65, stirringSpeed=470),
    dict(id="B-2026-021", date="2026-10-09", oilVolume=1000, ffa=5.0, ffaAboveStrip=True, esterificationRun=True, yield_=0, duration=51, energy=0.82, status="Failed", labResult="Not tested", temperature=40, reactionTime=31, stirringSpeed=430),
    dict(id="B-2026-020", date="2026-10-04", oilVolume=800, ffa=4, esterificationRun=True, yield_=85.7, duration=121, energy=1.52, status="Completed", labResult="Passed", temperature=41, reactionTime=54, stirringSpeed=420),
    dict(id="B-2026-019", date="2026-09-29", oilVolume=1000, ffa=1, esterificationRun=False, yield_=87.6, duration=135, energy=1.88, status="Completed", labResult="Pending", temperature=42, reactionTime=60, stirringSpeed=450),
]


def hydrate(row: dict) -> Batch:
    """Same defaults as hydrateAnalyticsData on the website."""
    oil_volume, ffa, ester = row["oilVolume"], row["ffa"], row["esterificationRun"]
    oil_g = oil_volume * 0.92
    ratio = 7
    trans_methanol = oil_g * ratio * 40.45 / 880
    dose_g = oil_g * 0.10                     # uniform esterification dose: as if FFA were 10%
    ester_methanol = dose_g * 2.84 if ester else 0
    extra = {
        "voltage": 30, "methanolRatio": ratio, "catalystType": "NaOH",
        "esterificationVoltage": 20 if ester else None,
        "esterificationTime": 120 if ester else None,
        "esterificationStirring": 500 if ester else None,
        "biodieselOutputMl": oil_volume * (row["yield_"] / 100),
        "oilMassG": oil_g,
        "notes": "Sample prototype data",
        "materials": Materials(
            oil_l=oil_volume / 1000,
            methanol_l=(trans_methanol + ester_methanol) / 1000,
            catalyst_kg=oil_g * 0.01 / 1000,
            sulfuric_acid_l=dose_g * 0.027 / 1000 if ester else 0,
            acetone_l=oil_volume * 0.1 / 1000,
            bentonite_kg=oil_volume * 0.02 / 1000,
        ),
    }
    data = {k: v for k, v in row.items() if k != "yield_"} | {"yield": row["yield_"]} | extra
    return Batch.model_validate(data)


# FFA of the sample batches in earlier versions (decimals, and the old 4% rule).
OLD_SAMPLE_FFA = {"B-2026-024": 2.8, "B-2026-022": 3.4, "B-2026-020": 4.6, "B-2026-019": 3.1}


def update_old_samples() -> int:
    """Sample batches saved by an earlier version get the new whole-number FFA values."""
    new_ffa = {row["id"]: row["ffa"] for row in DEMO_BATCHES}
    changed = 0
    for b in db.list_batches():
        if b.notes == "Sample prototype data" and OLD_SAMPLE_FFA.get(b.id) == b.ffa:
            b.ffa = new_ffa[b.id]
            db.save_batch(b)
            changed += 1
    return changed


def main(argv) -> None:
    db.init_db()
    if db.list_batches() and "--force" not in argv:
        changed = update_old_samples()
        print("The database already has batches. Use --force to add the samples anyway."
              + (f" Updated the FFA of {changed} sample batches to whole numbers." if changed else ""))
        return
    for row in DEMO_BATCHES:
        db.save_batch(hydrate(row))
    print(f"Added {len(DEMO_BATCHES)} sample batches.")


if __name__ == "__main__":
    main(sys.argv)
