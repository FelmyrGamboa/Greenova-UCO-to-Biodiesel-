"""Chemical amounts. Output keys match calculateQuantityCards() in the website's NewBatch.tsx.

Sources: Van Gerpen, Tech Note 33 (2.25 g methanol and 0.05 g sulfuric acid per gram of FFA;
catalyst with an FFA term); Canakci & Van Gerpen 2001 (20:1, then 40:1 methanol to FFA;
target below 1% FFA). FFA is taken "as oleic acid".
"""
from typing import Optional

from .models import Materials, Settings

METHANOL_ML_PER_G_FFA = {1: 2.84, 2: 5.68}   # stage 1 = 20:1, later stages = 40:1
H2SO4_ML_PER_G_FFA = 0.027                   # 98% sulfuric acid (0.05 g per g FFA)
H2SO4_G_PER_G_FFA = 0.05
NEUTRALIZATION_PER_G_FFA = {"KOH": 0.199, "NaOH": 0.142}
BASE_PER_G_H2SO4 = {"KOH": 1.144, "NaOH": 0.816}
METHANOL_ML_PER_MOL = 40.45                  # 32.04 g/mol ÷ 0.792 g/mL


def _r(x: float) -> float:
    return round(x, 4)


def needs_esterification(ffa: float, s: Settings) -> bool:
    return ffa > s.ffa_threshold


def oil_volume_ml(oil_g: float, s: Settings) -> float:
    return oil_g / s.oil_density


def purity(catalyst: str, s: Settings) -> float:
    return s.koh_purity if catalyst == "KOH" else s.naoh_purity


def esterification(oil_g: float, ffa: float, s: Settings, stage: int = 1) -> dict:
    ffa_g = oil_g * ffa / 100
    return {
        "stage": stage,
        "ffaMassG": _r(ffa_g),
        "esterificationMethanolMl": _r(ffa_g * METHANOL_ML_PER_G_FFA[1 if stage == 1 else 2]),
        "sulfuricAcidMl": _r(ffa_g * H2SO4_ML_PER_G_FFA),
        "sulfuricAcidG": _r(ffa_g * H2SO4_G_PER_G_FFA),
        "acetoneMl": _r(oil_volume_ml(oil_g, s) * s.acetone_fraction),
    }


def transesterification(oil_g: float, acid_pct: float, ratio: float, catalyst: str, s: Settings) -> dict:
    """acid_pct = the last FFA reading after esterification, or the starting FFA if it was skipped."""
    base_g = oil_g * s.catalyst_loading
    neutralization_g = oil_g * acid_pct / 100 * NEUTRALIZATION_PER_G_FFA[catalyst]
    p = purity(catalyst, s)
    return {
        "transesterificationMethanolMl": _r(oil_g * ratio * METHANOL_ML_PER_MOL / s.oil_molar_mass),
        "catalystBaseG": _r(base_g),
        "neutralizationG": _r(neutralization_g),
        "catalystToWeighG": _r((base_g + neutralization_g) / (p / 100)),
        "purity": p,
        "acetoneMl": _r(oil_volume_ml(oil_g, s) * s.acetone_fraction),
    }


def quantity_cards(oil_g: float, ffa: float, ratio: float, catalyst: str, s: Settings) -> dict:
    """Everything the Chemical Quantity Calculator shows. With esterification, the catalyst is an
    "up to" amount (neutralizing the target FFA); without it, the amount is exact."""
    ester_needed = needs_esterification(ffa, s)
    volume = oil_volume_ml(oil_g, s)
    warnings = []
    if volume < s.oil_minimum_volume_ml:
        warnings.append(f"Minimum oil volume is {s.oil_minimum_volume_ml:g} mL.")
    if volume > s.oil_maximum_volume_ml:
        warnings.append(f"Maximum supported oil volume is {s.oil_maximum_volume_ml:g} mL.")
    ester = esterification(oil_g, ffa, s)
    trans = transesterification(oil_g, s.ffa_target if ester_needed else ffa, ratio, catalyst, s)
    return {
        "oilMassG": oil_g,
        "oilVolumeMl": _r(volume),
        "ffa": ffa,
        "methanolRatio": ratio,
        "catalyst": catalyst,
        "ffaMassG": ester["ffaMassG"],
        "esterificationNeeded": ester_needed,
        "esterificationMethanolMl": ester["esterificationMethanolMl"],
        "sulfuricAcidMl": ester["sulfuricAcidMl"],
        "sulfuricAcidG": ester["sulfuricAcidG"],
        "acetoneMl": ester["acetoneMl"],
        "transesterificationMethanolMl": trans["transesterificationMethanolMl"],
        "catalystBaseG": trans["catalystBaseG"],
        "neutralizationG": trans["neutralizationG"],
        "catalystToWeighG": trans["catalystToWeighG"],
        "purity": trans["purity"],
        "isEstimate": ester_needed,
        "warnings": warnings,
    }


def after_esterification(oil_g: float, ffa_after: float, stage_done: int, ratio: float,
                         catalyst: str, s: Settings) -> dict:
    """After a stage: another stage if FFA is still above the target, otherwise the exact
    transesterification amounts."""
    if ffa_after > s.ffa_target:
        return {"action": "anotherStage", **esterification(oil_g, ffa_after, s, stage_done + 1)}
    return {"action": "transesterification", "ffa": ffa_after, "isEstimate": False,
            **transesterification(oil_g, ffa_after, ratio, catalyst, s)}


def fallback_neutralization_g(h2so4_g: float, oil_g: float, ffa_start: float, catalyst: str) -> float:
    """Worst case when no FFA reading after esterification is available: assumes all the acid
    stayed and FFA dropped to one-fifth. Usually too much base, so use only as a fallback."""
    return _r(h2so4_g * BASE_PER_G_H2SO4[catalyst]
              + oil_g * (ffa_start / 5) / 100 * NEUTRALIZATION_PER_G_FFA[catalyst])


def materials(oil_volume: float, ffa: float, esterification_run: bool, ratio: float, catalyst: str,
              s: Settings, catalyst_to_weigh_g: Optional[float] = None,
              esterification_stages: Optional[list] = None) -> Materials:
    """Materials used by a batch, for the cost per liter. Uses the recorded esterification stages
    when there are any; otherwise one stage at the starting FFA."""
    oil_g = oil_volume * s.oil_density
    trans = transesterification(oil_g, s.ffa_target if esterification_run else ffa, ratio, catalyst, s)
    stages = esterification_stages or []
    if esterification_run and not stages:
        e = esterification(oil_g, ffa, s)
        ester_methanol, acid, ester_acetone = e["esterificationMethanolMl"], e["sulfuricAcidMl"], e["acetoneMl"]
    else:
        ester_methanol = sum(st.methanol_ml for st in stages)
        acid = sum(st.sulfuric_acid_ml for st in stages)
        ester_acetone = sum(st.acetone_ml for st in stages)
    catalyst_g = catalyst_to_weigh_g if catalyst_to_weigh_g is not None else trans["catalystToWeighG"]
    return Materials(
        oil_l=_r(oil_volume / 1000),
        methanol_l=_r((ester_methanol + trans["transesterificationMethanolMl"]) / 1000),
        catalyst_kg=_r(catalyst_g / 1000),
        sulfuric_acid_l=_r(acid / 1000),
        acetone_l=_r((ester_acetone + trans["acetoneMl"]) / 1000),
        bentonite_kg=_r(oil_volume * s.bentonite_fraction / 1000),
    )
