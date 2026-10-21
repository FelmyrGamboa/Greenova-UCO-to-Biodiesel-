"""Sample batches for the automated tests only (analytics and database checks). The website
and the database never get sample data: Batch History shows only the batches the machine ran."""
from app.models import Batch, Materials

# Fixed sample batches for the analytics and database tests. FFA is a whole percent; FFA <= 3% goes straight to
# transesterification, anything higher is esterified first. ffaAboveStrip: the strip showed its
# darkest color (FFA 5% or more), recorded as 5.
DEMO_BATCHES = [
    dict(id="B-2026-024", date="2026-10-18", oilVolume=2000, ffa=1, esterificationRun=False, yield_=88.4, duration=132, energy=1.84, status="Completed", labResult="Passed", temperature=42, reactionTime=58, stirringSpeed=450),
    dict(id="B-2026-023", date="2026-10-16", oilVolume=5000, ffa=5.0, ffaAboveStrip=True, esterificationRun=True, yield_=86.9, duration=138, energy=1.91, status="Completed", labResult="Pending", temperature=41, reactionTime=62, stirringSpeed=440),
    dict(id="B-2026-022", date="2026-10-12", oilVolume=1500, ffa=3, esterificationRun=False, yield_=89.1, duration=147, energy=2.16, status="Completed", labResult="Passed", temperature=43, reactionTime=65, stirringSpeed=470),
    dict(id="B-2026-021", date="2026-10-09", oilVolume=5000, ffa=5.0, ffaAboveStrip=True, esterificationRun=True, yield_=0, duration=51, energy=0.82, status="Failed", labResult="Not tested", temperature=40, reactionTime=31, stirringSpeed=430),
    dict(id="B-2026-020", date="2026-10-04", oilVolume=3500, ffa=4, esterificationRun=True, yield_=85.7, duration=121, energy=1.52, status="Completed", labResult="Passed", temperature=41, reactionTime=54, stirringSpeed=420),
    dict(id="B-2026-019", date="2026-09-29", oilVolume=3000, ffa=1, esterificationRun=False, yield_=87.6, duration=135, energy=1.88, status="Completed", labResult="Pending", temperature=42, reactionTime=60, stirringSpeed=450),
]


def hydrate(row: dict) -> Batch:
    """A full Batch from a sample row (the materials worked out the way the website did)."""
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


SAMPLE_BATCHES = DEMO_BATCHES
