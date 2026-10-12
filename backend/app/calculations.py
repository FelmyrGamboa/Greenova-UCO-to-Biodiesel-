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
METHANOL_DENSITY = 0.792                     # g/mL
ACETONE_DENSITY = 0.784                      # g/mL

# Dosing pumps: the operator mixes each dose in the pump's tank, and the pump stops when the
# reactor load cell has gained the premix weight. Pump A ("catalyst") = NaOH/KOH dissolved in the
# transesterification methanol. Pump B ("acid") = H2SO4 stirred into the esterification methanol.


def _r(x: float) -> float:
    return round(x, 4)


def needs_esterification(ffa: float, s: Settings) -> bool:
    return ffa > s.ffa_threshold


def oil_volume_ml(oil_g: float, s: Settings) -> float:
    return oil_g / s.oil_density


def purity(catalyst: str, s: Settings) -> float:
    return s.koh_purity if catalyst == "KOH" else s.naoh_purity


def dose_ffa(ffa: float, s: Settings, stage: int = 1) -> float:
    """FFA the esterification dose is calculated for. The test strip only reads up to
    stripMaxFfa, so stage 1 always uses the uniform design FFA (default 10%): enough for any oil
    up to that, and the re-check after the stage catches the rest. Later stages use the
    re-check reading, which the strip can measure (it's at most a few percent)."""
    return s.esterification_design_ffa if stage == 1 else ffa


def esterification(oil_g: float, ffa: float, s: Settings, stage: int = 1) -> dict:
    dose = dose_ffa(ffa, s, stage)
    ffa_g = oil_g * dose / 100
    out = {
        "stage": stage,
        "doseFfa": dose,
        "uniformDose": stage == 1,
        "ffaMassG": _r(ffa_g),
        "esterificationMethanolMl": _r(ffa_g * METHANOL_ML_PER_G_FFA[1 if stage == 1 else 2]),
        "sulfuricAcidMl": _r(ffa_g * H2SO4_ML_PER_G_FFA),
        "sulfuricAcidG": _r(ffa_g * H2SO4_G_PER_G_FFA),
        # acetone is added once, in stage 1; it is still in the reactor for later stages
        "acetoneMl": _r(oil_volume_ml(oil_g, s) * s.acetone_fraction) if stage == 1 else 0.0,
    }
    out["acetoneG"] = _r(out["acetoneMl"] * ACETONE_DENSITY)
    # pump B premix: what the reactor load cell should gain
    out["esterificationPremixMl"] = _r(out["esterificationMethanolMl"] + out["sulfuricAcidMl"])
    out["esterificationPremixG"] = _r(out["esterificationMethanolMl"] * METHANOL_DENSITY + out["sulfuricAcidG"])
    return out


def transesterification(oil_g: float, acid_pct: float, ratio: float, catalyst: str, s: Settings) -> dict:
    """acid_pct = the last FFA reading after esterification, or the starting FFA if it was skipped."""
    base_g = oil_g * s.catalyst_loading
    neutralization_g = oil_g * acid_pct / 100 * NEUTRALIZATION_PER_G_FFA[catalyst]
    p = purity(catalyst, s)
    methanol_ml = oil_g * ratio * METHANOL_ML_PER_MOL / s.oil_molar_mass
    catalyst_g = (base_g + neutralization_g) / (p / 100)
    acetone_ml = oil_volume_ml(oil_g, s) * s.acetone_fraction
    return {
        "transesterificationMethanolMl": _r(methanol_ml),
        "catalystBaseG": _r(base_g),
        "neutralizationG": _r(neutralization_g),
        "catalystToWeighG": _r(catalyst_g),
        "purity": p,
        "acetoneMl": _r(acetone_ml),
        "acetoneG": _r(acetone_ml * ACETONE_DENSITY),
        # pump A premix (the dissolved catalyst barely changes the volume)
        "transesterificationPremixMl": _r(methanol_ml),
        "transesterificationPremixG": _r(methanol_ml * METHANOL_DENSITY + catalyst_g),
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
        "doseFfa": ester["doseFfa"],
        "uniformDose": ester_needed,
        "esterificationNeeded": ester_needed,
        "esterificationMethanolMl": ester["esterificationMethanolMl"],
        "sulfuricAcidMl": ester["sulfuricAcidMl"],
        "sulfuricAcidG": ester["sulfuricAcidG"],
        "acetoneMl": ester["acetoneMl"],
        "acetoneG": ester["acetoneG"],
        "esterificationPremixMl": ester["esterificationPremixMl"],
        "esterificationPremixG": ester["esterificationPremixG"],
        "transesterificationMethanolMl": trans["transesterificationMethanolMl"],
        "catalystBaseG": trans["catalystBaseG"],
        "neutralizationG": trans["neutralizationG"],
        "catalystToWeighG": trans["catalystToWeighG"],
        "purity": trans["purity"],
        "transesterificationAcetoneMl": trans["acetoneMl"],
        "transesterificationPremixMl": trans["transesterificationPremixMl"],
        "transesterificationPremixG": trans["transesterificationPremixG"],
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
