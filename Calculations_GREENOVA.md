# Greenova Process Calculations

Updated Oct 13, 2026 (Magnesol dry wash amount). Default formulas for esterification, transesterification and purification. The batch analytics fine-tunes voltage, time and stirring per FFA range; these formulas set the chemical amounts.

## Inputs

- V = oil volume (mL), from the reactor load cell, minimum 100 mL. The weight is recorded when the operator confirms the oil; later additions (acetone, pumped doses) don't change it.
- FFA = free fatty acid % (as oleic acid), from the test strip. The strip reads only up to 5%: its darkest color means "5% or more", recorded as ≥ 5%.
- R = transesterification methanol-to-oil molar ratio, 6:1 to 9:1, default 7:1
- Catalyst type: KOH (default) or NaOH, and its purity (check the label)

## Constants

| Constant | Value |
|---|---|
| Oil density | 0.92 g/mL |
| Oil molar mass (M_oil) | 880 g/mol for used cooking/palm oil; about 660 g/mol for coconut oil |
| Methanol | 32.04 g/mol, 0.792 g/mL |
| Sulfuric acid, 98% | 98.08 g/mol, 1.84 g/mL |
| Acetone | 0.784 g/mL |
| KOH / NaOH | 56.11 / 40.00 g/mol |
| FFA (as oleic acid) | 282.47 g/mol |
| Purity defaults | KOH 90%, NaOH 98% |
| FFA cutoff for esterification | 4% |
| FFA target after esterification | 1% |
| Design FFA for the uniform dose | 10% (Settings → Esterification and Dosing) |
| Strip maximum (darkest color) | 5% |
| Magnesol dose | 1% of the biodiesel weight (taken as the oil weight) |

## 1. Basic amounts

- Oil weight W (g) = V × 0.92
- If FFA > 4%: run esterification (section 2). Otherwise skip to transesterification (section 3).

## 2. Esterification (acid-catalyzed, electrochemical)

**Uniform dose (decided Oct 12, 2026).** The strip can't tell 6% from 9%, so every batch above 4% gets the same first dose, calculated as if the oil had the design FFA (10%):

- Dose FFA weight (g) = W × 10 ÷ 100
- Methanol (mL) = dose FFA weight × 2.84 (20:1 methanol to FFA)
- Sulfuric acid 98% (mL) = dose FFA weight × 0.027 (= × 0.05 g)
- Acetone (mL) = V × 0.10, added once, in stage 1
- Per 100 mL of oil: about 26 mL methanol and 0.25 mL H₂SO₄. Per 500 mL: 131 mL and 1.24 mL.
- Default settings: 20 V, 1 A, 500 rpm, 120 min (room temperature). Ranges: 10–30 V, 0.5–2 A, 30–180 min.

This covers oil up to 10% FFA. Oil just above 4% gets more methanol and acid than it strictly needs; the extra comes out in the methanol-water layer.

**Re-check after each stage.** Let it settle, drain the top methanol-water-acid layer, then test the oil layer with a new strip (FFA_after; the strip can read it, since it's usually a few percent at most).
- If FFA_after > 1%: run another stage, dosed for the reading (40:1), with no new acetone:
  - Methanol (mL) = W × FFA_after ÷ 100 × 5.68
  - Sulfuric acid 98% (mL) = W × FFA_after ÷ 100 × 0.027
  - If the strip still shows its darkest color, the next stage is dosed for 10% again.
- If FFA_after ≤ 1%: go to transesterification with the exact catalyst amount.

## 3. Transesterification (base-catalyzed, electrochemical)

A = acid to neutralize (%) = the last FFA re-check after esterification, or the starting FFA if esterification was skipped. The strip reading covers both leftover FFA and leftover sulfuric acid. Before the re-check, the calculator shows an "up to" amount using the 1% target.

- Catalyst (g) = W × 0.01
- Neutralization (g) = W × A ÷ 100 × 0.199 for KOH, or × 0.142 for NaOH
- Total to weigh (g) = (catalyst + neutralization) ÷ purity
- Methanol (mL) = W × R × 40.45 ÷ M_oil
- Acetone (mL) = V × 0.10
- Settings: 30 V, 1 A, 120 min by default (ranges 10–30 V, 0.5–2 A, 30–180 min). Base study (Fereidooni and Kasaeian 2024): 30 V, 2 h, room temperature; stirring not given

Fallback when no FFA reading after esterification is available (worst case; usually adds too much base):
- Neutralization KOH (g) = sulfuric acid g × 1.144 + W × (FFA ÷ 5) ÷ 100 × 0.199
- Neutralization NaOH (g) = sulfuric acid g × 0.816 + W × (FFA ÷ 5) ÷ 100 × 0.142

## 4. Pump premixes (what each dosing pump loads)

The operator mixes each dose in the pump's tank (about 10% extra in the same proportions, so the line stays full). The pump stops when the reactor load cell has gained the premix weight, so the acetone is poured only after the pump has finished.

- Pump B (esterification) = methanol mL × 0.792 + sulfuric acid g. Add the acid slowly to the methanol.
- Pump A (transesterification) = methanol mL × 0.792 + catalyst to weigh (g). Dissolve the catalyst fully first.

## 5. Purification (dry wash with Magnesol, Oct 13, 2026)

- Magnesol (g) = V × 0.92 × 1% = **V × 0.0092**, rounded to 0.1 g. The biodiesel weight is taken as the oil weight.
- It is shown in Volume & Parameters as "Magnesol (dry wash): X g" and asked for in purification as "Add X g Magnesol (1% of biodiesel)".

| Oil volume | Magnesol |
|---|---|
| 100 mL | 0.9 g |
| 250 mL | 2.3 g |
| 500 mL | 4.6 g |
| 750 mL | 6.9 g |
| 1,000 mL | 9.2 g |

The software uses 1% only. The dose table we were given also lists 2% for high-soap oil; that is not a setting yet.

Purification sequence (fixed values except the four Settings times): heat to 90 °C with the stirrer at 200 RPM (fault after 15 min), methanol removal at 90 ±2 °C for 10 min (5–30), heater off and add the Magnesol, contact 15 min stirring, settling 10 min with the stirrer off, cool to 50 °C or below if needed (water filter limit), then drain until the output load cell is steady (±2 g for 30 s, 20 min at most). Heater cutoff: 95 °C.

## 6. Output

- Biodiesel volume (mL) = output load cell weight ÷ 0.88
- Yield (%) = biodiesel mL ÷ oil mL × 100
- Low output warning ("check the filter") when the output weight is below 70% of the oil weight

## Worked example: 1,000 mL oil, strip shows 5% or more, KOH 90%, 7:1

| Step | Calculation | Result |
|---|---|---|
| Oil weight | 1,000 × 0.92 | 920 g |
| Dose FFA weight (uniform, 10%) | 920 × 10 ÷ 100 | 92 g |
| Stage 1 methanol | 92 × 2.84 | 261.3 mL |
| Stage 1 sulfuric acid | 92 × 0.027 | 2.48 mL (4.6 g) |
| Pump B premix, stage 1 | 261.3 × 0.792 + 4.6 | 211.5 g |
| Acetone (by hand, after pump B) | 1,000 × 0.10 | 100 mL (78.4 g) |
| FFA re-check after stage 1 | strip | 1.2%, above 1%, so run stage 2 |
| Stage 2 methanol | 920 × 1.2 ÷ 100 × 5.68 | 62.7 mL |
| Stage 2 sulfuric acid | 920 × 1.2 ÷ 100 × 0.027 | 0.30 mL (0.55 g) |
| Pump B premix, stage 2 | 62.7 × 0.792 + 0.55 | 50.2 g |
| FFA re-check after stage 2 | strip | 0.5%, go to transesterification |
| Catalyst | 920 × 0.01 | 9.2 g |
| Neutralization | 920 × 0.5 ÷ 100 × 0.199 | 0.92 g |
| KOH to weigh | (9.2 + 0.92) ÷ 0.90 | 11.24 g |
| Transesterification methanol | 920 × 7 × 40.45 ÷ 880 | 296.0 mL (394.7 mL if M_oil = 660) |
| Pump A premix | 296.0 × 0.792 + 11.24 | 245.7 g |
| Acetone (by hand, after pump A) | 1,000 × 0.10 | 100 mL |
| Magnesol (dry wash) | 1,000 × 0.0092 | 9.2 g |

NaOH instead (98%): neutralization 0.65 g, NaOH to weigh 10.05 g.
Skipped esterification at 3% FFA: neutralization 5.49 g, KOH to weigh 16.32 g.

## Sources

- Van Gerpen, Tech Note 33: Converting high FFA feedstocks (2.25 g methanol and 0.05 g sulfuric acid per gram of FFA; catalyst formula with FFA term).
- Canakci & Van Gerpen (2001), high-FFA pretreatment (20:1 then 40:1 methanol to FFA; target below 1% FFA).
- Fereidooni and Kasaeian, 2024 AIChE abstract (electrolysis at 30 V, 7:1, 1 wt% catalyst, acetone, 2 h, room temperature).
- Magnesol dose table supplied by the team (1% default, 2% for high soap; citing Faccini et al., UPLB and The Dallas Group).
