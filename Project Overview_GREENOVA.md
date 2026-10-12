# Greenova Project Overview

Oct 11, 2026, updated Oct 13 · @Chryzel

Greenova is our computer-engineering thesis: an electrochemical biodiesel prototype for jeepney drivers, run by a Raspberry Pi and a web dashboard. Prototype hardware is built and wired, and we are now writing Chapters 4-5 and preparing for the defense.

## Project at a glance

- **Thesis title:** "GREENOVA: ELECTROCHEMICAL BIODIESEL PRODUCTION WITH BATCH ANALYTICS AND CENTRIFUGAL SEPARATION". (Earlier working title: "Greenova: Biodiesel Processing with Batch Analytics and Centrifugal Separation".)
- **Goal:** a biodiesel production loop on one Raspberry Pi that logs each batch, compares batches, and holds the settings that gave the best biodiesel quality. Pi scope is basic monitoring, regulation and comparative analysis. Oil, acetone and Magnesol are added by hand; the two reagent premixes are loaded by dosing pumps.
- **"Batch analytics"** means biodiesel yield and quality per batch, not machine learning. The study has no ML model (no LoRA, YOLO, etc.).
- **Beneficiary:** jeepney drivers who want lower fuel costs.
- **Team:** computer-engineering students, not chemists, with limited time and mechanical skills.
- **Prototype target:** a sturdy, working 50-70% prototype, not a pretty one.

## Beneficiaries and field findings

- Current interviews target boundary-system (non-owner) jeepney drivers from Cubao.
- Drivers say coconut oil feedstock costs about ₱10-20 less than crude oil.
- They would buy quality biodiesel at half the current diesel price. Diesel is about ₱50-60.

## Process and chemistry

We make biodiesel by direct electrolysis in a cell with electrolyte, not by generating methoxide in situ. The base study is Fereidooni and Kasaeian (University of Tehran), a 2024 AIChE poster abstract on electrolysis of waste frying oil; our default parameters follow it. Cite it as "Fereidooni and Kasaeian (2024)", not "Kasaeian". Its title says KOH but the abstract reports 1 wt% NaOH. Esterification and transesterification are two separate stages.

- **Electrodes and power (Oct 13, 2026):** graphite–graphite electrodes (an interim plan used copper tube and stainless steel), fed by a 30 V variable DC supply. Each reaction stage has a current setting, default 1 A (0.5–2 A). If the Pi can control the supply, it sets the current limit; otherwise the operator sets it by hand ("Set the power supply current to 1 A"). Either way, the backend cuts electrode power and warns if the measured current goes above the setting.
- **Temperature:** no heating band in the reaction stages. A temperature sensor is used for safety, and temperature is not an operator setting.
- **Esterification (pre-treatment):** sulfuric acid (H₂SO₄) with methanol.
- **Transesterification:** KOH (NaOH is possible) with methanol.
- **Co-solvent:** acetone helps the oil mix with the methanol and catalyst. It is poured after the pump has loaded the dose, because the pump doses by the reactor load cell's weight gain.
- **FFA rule:** FFA % is typed in by hand from a test strip, because we have no FFA sensor. FFA above 4% means esterification first, then transesterification. FFA below 4% goes straight to transesterification.
- **Strip limit and uniform dose (decided Oct 12, 2026):** the strip reads only up to 5%; above that it stays the same darkest color. The operator ticks "darkest color" and the batch is recorded as ≥ 5%. Every batch above 4% gets one uniform esterification dose, calculated as if FFA were 10% (about 26 mL methanol and 0.25 mL H₂SO₄ per 100 mL oil). After each stage the operator re-checks the FFA with a new strip: above 1%, another stage dosed for that reading (40:1, no new acetone); at or below 1%, transesterification with the exact catalyst amount. Formulas are in `claude/greenova-calculations.md`. The analytics FFA ranges are 0–2%, 2–4%, 4–5% and 5% and above.
- **After the reactions:** the reactor outlet drains into the centrifuge for 1 min. Centrifugal separation runs 10 min at 2,600 RPM (an earlier plan said about 1,800 RPM), then purification by dry wash with Magnesol stirred into the biodiesel in the heated purification tank, then through the outlet filter. Filter screens sit on the oil input and the biodiesel output.
- **Adsorbent (Oct 13, 2026):** the website's purification uses Magnesol (magnesium silicate) at 1% of the biodiesel: oil volume (mL) × 0.0092 g, e.g. 4.6 g for 500 mL. Activated bentonite was also planned for comparison; the software has no bentonite option, and the cost per liter still uses the bentonite price.
- **Purification is automatic (redesigned Oct 13, 2026, replacing the mesh bed flow):** after separation it runs by itself with an immersion heater and a stirrer at a fixed 200 RPM (live reading shown as "198 / 200 RPM"):
  1. Heating: stirrer on, then heater, until 90 °C (fault if not reached in 15 min). The website says "Prepare X g Magnesol".
  2. Methanol removal: hold 90 ±2 °C for 10 min (methanol boils at 64.7 °C).
  3. Add Magnesol: heater off, stirrer on; "Add X g Magnesol (1% of biodiesel)" with a Confirm button.
  4. Contact: stir 15 min, heater off.
  5. Settling: 10 min, stirrer off.
  6. Cooling, only if needed: wait until ≤ 50 °C (water filter limit).
  7. Draining: outlet valve open; done when the output load cell is steady (±2 g) for 30 s, 20 min at most.
  8. Done: warns "Low output – check the filter" below 70% of the oil weight; the operator confirms.

  A float (level) switch at the heater's height starts it and protects against dry heating. Without the switch, the operator confirms once that the heater is submerged. Safety: the heater runs only while the stirrer is running and the heater is submerged, the valve never opens while the heater is on, 95 °C software cutoff, thermal fuse as hardware backup. Only methanol removal time (5–30 min), contact time, settling time and max drain temperature are in Settings → Purification.

### Chemical amounts (per 100 mL of oil, about 92 g)

Worked example for 500 mL of oil: 150 mL methanol, 4.6 g catalyst, 50 mL acetone, 4.6 g Magnesol.

| Input | Rule | Per 100 mL oil |
|---|---|---|
| Methanol | molar ratio 6:1 to 9:1, default 7:1 | about 30 mL at 7:1 (about 26 mL at 6:1, 39 mL at 9:1, scaled from 7:1) |
| Catalyst | 1 wt% of the oil | about 0.9 g |
| Acetone co-solvent | about 10% of the oil, to be confirmed by testing | 10 mL |
| Magnesol (dry wash) | 1% of the biodiesel (oil mL × 0.0092 g) | 0.9 g |
| Oil input | read by the load cell, minimum 100 mL | n/a |

### Reaction settings (Oct 13, 2026)

| Setting | Range | Esterification default | Transesterification default |
|---|---|---|---|
| Voltage | 10-30 V | 20 V (most studies use about 20 V) | 30 V |
| Current | 0.5-2 A | 1 A | 1 A |
| Reaction time | 30-180 min | 120 min | 120 min |
| Stirring speed | 400-700 rpm | 500 rpm | 500 rpm |

The source PDF also includes a reference table of typical acid-esterification settings: 6:1 methanol:oil, 1 wt% H₂SO₄, 60 °C, 60 min, 500 rpm (ranges 6:1-12:1, 0.5-2 wt%, 55-65 °C, 30-90 min, 400-600 rpm). Our own settings above take priority.

## Prototype hardware

The frame, the stainless steel reactors and chambers, and the other mechanical parts were custom-made after consulting an expert. We did the connections, the calibrations and everything else.

- **Controllers:** Raspberry Pi 4 Model B and an ESP32, with wiring done for the connected parameters. The Pi and the website control and monitor the stirring.
- **Sensors:** temperature (safety), electrode voltage and current, RPM on all three motors, and a timer per stage.
- **Load cells:** two 3 kg load cells, one HX711 each. The reactor load cell weighs the oil, the acetone and the pumped doses; the output load cell under the biodiesel container gives the yield and tells when draining is done.
- **Inputs (Oct 12, 2026):** oil and acetone are poured by hand through the inlet filter. Two automatic dosing pumps, each with its own tank: pump A loads NaOH/KOH dissolved in methanol (transesterification), pump B loads H₂SO₄ in methanol (esterification). The operator mixes each dose in the tank; the pump loads it by itself when the stage opens and stops when the reactor load cell has gained the dose weight.
- **Motors:** three DC motors: the reactor stirrer, the centrifuge and the purification stirrer, each with a MOSFET driver and RPM monitoring. The Before You Start screen shows Ready / Not ready for each, and for the heater.
- **Valves and lines:** three motorized valves, shown on the website as Open / Closed only. The reactor outlet opens after transesterification for 1 min (reactor → centrifuge). The centrifuge outlet opens after separation, once the centrifuge has stopped (centrifuge → purification tank, default 3 min). The purification outlet opens for draining (purification tank → filter → biodiesel container). Flexible tubing for the biodiesel lines.
- **Reactor:** 2 L prototype, with 1-1.5 L batches planned. Glycerin leaves at the back and biodiesel at the front.
- **Centrifuge:** double-chamber design. The inner chamber spins and collects the glycerol, and the biodiesel leaves through the outer chamber. An earlier plan referenced a continuous cone-bowl type.

## Website

The Greenova dashboard is built in Figma Make with dark and light themes, in English or Filipino (Tagalog) (Settings → Language; technical words such as biodiesel, Magnesol, FFA, RPM and valve stay in English). Its pages are Dashboard, Process, Batch History and Settings, and it shows the signed-in operator (Operator 01) and a System badge. The Process page is a guided stepper: Before You Start, Volume & Parameters, Oil Loading, Esterification (when FFA is above 4%), Transesterification, Separation, Purification, then Process Complete. "Before You Start" shows auto-verified system status and safety guidance only, with no manual preparation checklist. The operator loads the oil and chemicals, and the machine then proceeds on its own. Live monitoring shows only the current stage's readings: time remaining, voltage, current, stirrer RPM and temperature in the reaction stages; temperature, stirrer, heater, outlet valve and step time in purification (collected weight only while draining).

### Earlier feedback PDF (all done)

| Screen | Change |
|---|---|
| Safety guidance | H₂SO₄, NaOH or KOH, acetone, and (Oct 13) Magnesol dust and the hot purification tank. |
| Volume & Parameters | FFA % input first with the 4% rule, oil input from the load cell (100 mL minimum), corrected methanol and catalyst calculation, methanol ratio option, stage settings with the ranges above, and the Magnesol amount. |
| Oil Loading | No "Pre-Heat" text. One button that goes straight to the next stage. |
| Electrochemical Process | Two separate stages: Esterification and Transesterification. |
| Automatic Separation | Centrifuge runs 10 min at 2,600 RPM. |
| Biodiesel Output | Renamed to Purification. |
| Batch History | "Engine Test" column replaced with Quality Passed (Passed/Failed). |
| Analytics tab | Left as it is. |

Batch History shows sample prototype data plus the batches saved on the Pi. Its Analytics tab holds a yield comparison chart, an energy-and-processing-time chart, and correlation charts labeled as association only.

## Process flow

The black-and-white flowchart is a separate file. This list follows it step by step, with the Oct 12 and Oct 13 changes.

1. Start. The dashboard shows the safety guidance and the auto-verified system status. If the status is not OK, fix it and re-check.
2. The operator acknowledges the guidance and starts the batch.
3. The operator pours the oil through the inlet filter and the reactor load cell reads it. Below 100 mL, add more oil.
4. The system calculates the methanol, catalyst, acetone and Magnesol amounts.
5. The operator enters the FFA % from a test strip, or ticks "darkest color" when it reads 5% or more.
6. If FFA is above 4%: mix methanol + H₂SO₄ in tank B; pump B loads it by itself when the stage opens; pour the acetone after the pump finishes; the electrochemical esterification starts by itself (uniform dose). Re-check the FFA: above 1%, run another stage dosed for the reading; at or below 1%, continue. If FFA is not above 4%, skip this step.
7. Mix methanol + KOH in tank A; pump A loads it by itself; pour the acetone; the electrochemical transesterification starts by itself. The reactor outlet valve then opens by itself for 1 min and the mixture flows to the centrifuge.
8. Centrifugal separation for 10 min at 2,600 RPM. When the centrifuge has stopped, its outlet valve opens by itself and the biodiesel flows to the purification tank; the glycerol stays in the inner chamber.
9. Purification, automatic: heat to 90 °C, remove methanol for 10 min, add the Magnesol (operator confirms), contact 15 min, settle 10 min, cool to 50 °C if needed, then drain through the outlet filter. The operator confirms when it's finished.
10. The biodiesel goes into the output container; the output load cell weighs it for the yield.
11. Manual quality test. If it passes, run the engine test. If not, send a sample for a lab test. If the lab test passes, run the engine test. If it still fails, log the failure and decide on proper disposal.
12. Record the batch result (Passed/Failed) in Batch History. End.

## Quality validation and standards

- We judge the biodiesel against the PNS for CME blends and ASTM D6751.
- **Plan:** send a few batches to a lab for standards or certification testing, wait for the result of each batch, then compare and calibrate against the sensor we will build. We consider validation done once quality is consistent across batches.
- **Sensors:** we have not yet decided which sensors will assess biodiesel quality.
- **Dashboard:** it only shows Passed or Failed for lab tests.
- **Panel framing:** keep the quality explanation about validating the biodiesel output, and not too technical, because we are computer engineers and not familiar with chemistry.

## How to work with us

- Explain chemistry in plain words. We are computer engineers.
- We lack time and mechanical skills, so prefer ready-to-buy parts that local electronics shops carry over custom fabrication.
- Aim for something sturdy and working, not polished.
- We are writing Chapters 4-5 (summary, findings, conclusions, recommendations) and preparing for the defense, so answers should hold up in front of the panel.
- The Statement of the Problem is under revision and is left out of this overview on purpose. Leave it out of thesis overviews until we say otherwise.
- Our own notes, including the website feedback, are written in a mix of English and Filipino.

## Open items

- **Catalyst amount:** the PDF note first says 3 g per 100 mL of oil, then gives 1 wt% (about 0.9 g). This overview uses 1 wt%.
- **Methanol ratio default:** the reference table says 6:1 (range 6:1-12:1), our note says 7:1 (range 6:1-9:1). This overview uses 7:1.
- **Reaction temperature:** the reference table lists 60 °C, but our reaction has no heating band and temperature is only monitored for safety.
- **Acetone amount:** about 10% of the oil still needs testing.
- **Power supply current control:** off by default (`GREENOVA_PSU_CURRENT_CONTROL=1` turns it on); the code that sets the supply's current limit from the Pi is still a TODO, so for now the operator sets 1 A by hand.
- **Purification timing:** design defaults are set (90 °C, 10 min methanol removal, 15 min contact, 10 min settling, ≤ 50 °C drain). They still need to be validated by testing, e.g. flash-point lab tests at different methanol removal times. Reaching 90 °C quickly needs a heater sized for the batch; a smaller heater just takes longer (the limit is 15 min).
- **Magnesol temperature:** magnesium silicate may work less well above 65 °C (Rudiyanto et al., 2022), and the Magnesol goes in right after the 90 °C hold with the heater off. Measure the temperature during contact, and consider letting it cool before adding the Magnesol if results are poor. The 2% dose for high-soap oil is not a setting yet.
- **Bentonite:** the comparison with activated bentonite has no software option yet, and the cost per liter still uses the bentonite price. Decide whether Magnesol replaces it.
- **Level switch:** buy a float switch for the purification tank to allow fully automatic start. Without it, the operator confirms once that the heater is submerged.
- **Oil volume limits:** the minimum is 100 mL and the website caps input at 1,000 mL, while batches are planned at 1-1.5 L on a 2 L prototype.
- **FFA exactly 4%:** the rule only covers above and below 4%. The software treats exactly 4% as no esterification.
- **Uniform dose check:** the 10% design FFA covers oil up to 10% FFA. Validate with a few high-FFA batches that one stage usually reaches ≤ 1%, and adjust the design FFA in Settings if not.
- **Machine assumptions to confirm:** the reactor and centrifuge outlets stay open for a set time (no level sensor behind them); each pump tank holds one batch's premix, mixed by the operator. Valve wiring is assumed to be one relay per valve that opens it while ON. The Pi sensor readers (load cells, RPM, voltage and current) are still TODOs in `PiHardware`.
- **Batch analytics:** an earlier design had the system take lab results, then automatically align default parameters to the best, most consistent batches. This is not in the latest flow, and the Analytics tab is on hold.
- **Engine test:** Batch History now shows Quality Passed/Failed instead of Engine Test, but the process flow still includes an engine test step.
- **Quality sensors:** still undecided.
