Update the existing Greenova web application based ONLY on the requirements below.

IMPORTANT:
Do NOT redesign, remove, restructure, or modify any other parts of the existing system that are not explicitly mentioned in this prompt.

Preserve the existing:
- page structure
- navigation structure
- existing features
- existing components
- existing functionality
- existing content unless specifically instructed to change it
- spacing and layout where possible
- responsive behavior
- overall application flow

Only make the changes and additions explicitly specified below.

==================================================
1. GREENOVA LOGO — REPLACE THE EXISTING LOGO
==================================================

Replace the current Greenova logo everywhere in the system with the new logo image that I will upload to Figma Make.

The uploaded image is the ONLY logo that should be used.

The new logo is:
- Text only: "Greenova"
- No fuel pump icon
- No leaves
- No additional icon
- "Green" is white
- "ova" is green
- The green used for "ova" should be a darker, controlled green that works well with the existing dark-mode interface
- Keep the logo exactly as provided in the uploaded image
- Do not recreate, redraw, restyle, or add effects to the logo
- Do not add a background behind the logo
- Do not change its proportions

Replace the existing Greenova logo with this uploaded logo wherever the existing logo currently appears, including the sidebar/header branding if applicable.

Make sure the logo remains clearly readable against the dark background.

==================================================
2. OVERALL VISUAL THEME
==================================================

Refine the entire application's visual theme so it feels consistent with a dark, professional, engineering/research-oriented biodiesel monitoring system.

The current interface uses too much bright green.

Reduce the intensity and amount of bright green throughout the interface.

Use green primarily as an accent color for:
- primary actions
- active states
- successful/completed states
- important process indicators
- progress indicators
- selected navigation items
- relevant data highlights

Do NOT make the entire interface bright green.

The overall visual hierarchy should be:

- Very dark background
- Slightly lighter dark panels/cards
- White/off-white text for primary information
- Muted gray text for secondary information
- Controlled dark green/emerald accents
- Green only where it provides meaning or emphasis

The theme should look:
- professional
- clean
- modern
- technical
- suitable for a research project
- suitable for an IoT monitoring dashboard
- easy to read
- not overly colorful
- not overly futuristic
- not "AI-generated looking"

Avoid:
- excessive neon green
- glowing effects
- excessive gradients
- unnecessary glassmorphism
- excessive rounded cards
- overly decorative elements
- excessive animations
- overly bright backgrounds

Keep the dark theme as the primary visual identity.

==================================================
3. HOME — NOT AUTHENTICATED
==================================================

The unauthenticated experience should contain the following pages:

### Login Page
Used for account authentication.

### Register Page
Allow users to:
- Register manually
- Sign in/register with Google

### Home Page
Provide a clear description of the Greenova research/project.

The Home Page should communicate what Greenova is and its purpose as a small-scale biodiesel processing system with monitoring and automation.

Do not make the content sound overly promotional or AI-generated.

Keep the wording simple, technical, natural, and research-oriented.

==================================================
4. LOGIN PAGE CONTENT
==================================================

Modify ONLY the specified login-page content.

Replace the current:

"Smarter Biodiesel Production"

and

"Monitor, manage, and optimize your small-scale biodiesel production process in real time for better quality, efficiency, and sustainability."

with more natural, straightforward wording appropriate for an undergraduate engineering/research project.

Use wording that clearly explains that Greenova is a system for monitoring and managing a biodiesel production process.

Avoid phrases that sound like generic AI marketing copy such as:
- "Smarter Biodiesel Production"
- "optimize your..."
- overly promotional claims
- exaggerated sustainability claims

The login page should feel like a real engineering/research system rather than a commercial AI product.

Also:

REMOVE the visible demo credentials from the Login Page.

Do not display demo email/password credentials anywhere on the login screen.

For the email field, do NOT use:

"you@example.com"

Use a natural placeholder such as:

"Enter your email address"

The password field should use an appropriate password placeholder.

Do not change the authentication functionality unless necessary for these visual/content changes.

==================================================
5. HOME — AUTHENTICATED DASHBOARD
==================================================

After authentication, the user should enter the authenticated Greenova system.

The main dashboard should include a clear connection area for connecting the Greenova software to the biodiesel processing machine.

The connection concept may use:
- a machine connection interface
- connection code
- QR code
- or another simple connection method

The important requirement is that the authenticated dashboard clearly communicates whether the software is connected to the processing machine.

Example states:

Disconnected:
"Connect to Machine"

Connected:
"Machine Connected"

Do not unnecessarily complicate the connection interface.

Once the machine is connected, the user can access the live monitoring and control features.

==================================================
6. LIVE DASHBOARD
==================================================

Create/maintain a Live Dashboard for monitoring and controlling the biodiesel processing system.

This is where the actual process parameters and machine status are displayed.

The Live Dashboard should allow the user to monitor relevant parameters such as:

- Oil/feedstock input
- Oil volume
- FFA percentage/result
- Temperature
- Reaction time
- Stirring speed
- Current processing stage
- Overall process progress
- Machine/system status
- Current batch information

Where applicable, provide controls for parameters that are intended to be user-configurable.

The interface should clearly distinguish:

USER INPUTS
from
SYSTEM-GENERATED DATA

Use appropriate status indicators and units.

The dashboard should prioritize real-time process information and make the current stage immediately understandable.

==================================================
7. BIODIESEL PROCESS WORKFLOW
==================================================

The system must follow this exact process workflow.

Do NOT remove or reorder these stages.

--------------------------------------------------
STAGE 1 — START
--------------------------------------------------

User action:
Tap "Start Process"

System action:
The system enters the Ready state and proceeds to FFA Testing.

--------------------------------------------------
STAGE 2 — FFA TESTING
--------------------------------------------------

User action:
Confirm that the oil sample is loaded into the FFA test chamber.

System action:
Run the FFA test using the strip/sensor reading.

Display:
- FFA percentage result
- Testing status
- Relevant sample information

--------------------------------------------------
STAGE 3 — PROCESS SELECTION
--------------------------------------------------

User action:
Confirm or override the suggested process.

System action:
Recommend the appropriate process based on the FFA result:

- High FFA → Esterification
- Low FFA → Transesterification

Clearly show:
- FFA result
- Recommended process
- User confirmation/override option

--------------------------------------------------
STAGE 4 — VOLUME INPUT
--------------------------------------------------

User action:
Enter:
- Oil volume in mL
- Required ratio

System action:
Calculate:
- Catalyst amount
- Alcohol/methanol amount
- Secondary catalyst dose, if required by the selected ratio

Clearly display the calculated values before proceeding.

--------------------------------------------------
STAGE 5 — PREPARATION INSTRUCTION
--------------------------------------------------

User action:
Confirm the preparation checklist.

The system should display the instruction:

"Mix catalyst with methanol before pouring into oil."

Provide a confirmation/checklist interaction before continuing.

--------------------------------------------------
STAGE 6 — PARAMETER SELECTION
--------------------------------------------------

User chooses:

- Default
OR
- Custom

Parameters include:
- Temperature
- Reaction time
- Stirring speed

Default:
Load pre-validated safe values.

Custom:
Allow numeric input, but reject or clamp values outside the defined safe operating range.

Clearly show the allowed/safe range when appropriate.

--------------------------------------------------
STAGE 7 — OIL LOADING + PREHEAT
--------------------------------------------------

This stage is automatic.

System actions:
- Load/pour oil
- Preheat the oil
- Remove water content or liquify solid oil when necessary

Display:
- Current temperature
- Target temperature
- Process status
- Current phase/stage label

--------------------------------------------------
STAGE 8 — REACTION STAGE
--------------------------------------------------

This stage is automatic.

The system runs the selected process using the selected parameters.

Display in real time:
- Elapsed time
- Remaining/countdown time
- Temperature
- Stirring speed
- Current reaction process
- Progress

--------------------------------------------------
STAGE 9 — AUTOMATIC SEPARATION
--------------------------------------------------

This stage is automatic.

System separates:
- Biodiesel
- Glycerol

Display:

"Separating"

Show the current separation status/progress.

--------------------------------------------------
STAGE 10 — DRY WASH INPUT
--------------------------------------------------

User enters dry-wash parameters such as:
- Amount
- Number of cycles

System then runs the dry-wash stage using the provided parameters.

--------------------------------------------------
STAGE 11 — FILTRATION + DRAIN
--------------------------------------------------

This stage is automatic.

System:
1. Filters the biodiesel
2. Drains the biodiesel into the dedicated output container

Display the process states sequentially:

"Filtering"

then

"Draining"

--------------------------------------------------
STAGE 12 — COMPLETE
--------------------------------------------------

When processing is finished, display:

"Process Complete"

Show a batch summary containing information such as:
- Batch ID
- Oil/feedstock volume
- Process used
- FFA result
- Total processing time
- Relevant final process information

==================================================
8. PROCESS TIMELINE
==================================================

The Live Dashboard should include a clear process timeline showing all 12 stages:

1. Start
2. FFA Testing
3. Process Selection
4. Volume Input
5. Preparation
6. Parameter Selection
7. Oil Loading + Preheat
8. Reaction Stage
9. Automatic Separation
10. Dry Wash Input
11. Filtration + Drain
12. Complete

The timeline must visually indicate:
- Completed stages
- Current stage
- Upcoming stages

Do not use excessive bright colors.

Use a controlled green accent for completed/successful stages and a subtle but visible active-state treatment for the current stage.

==================================================
9. PAST BATCHES / BATCH HISTORY
==================================================

Create/maintain a Past Batches / Batch History section.

This should contain records of previous biodiesel production batches.

Each batch record should provide relevant information such as:
- Batch ID
- Date/time
- Feedstock/oil information
- Oil volume
- FFA result
- Process used
- Reaction parameters
- Processing time
- Final output information
- Status
- Success/failure result

Each batch should be viewable in more detail.

The batch details should include a process timeline showing what happened during that batch.

==================================================
10. BATCH CORRELATIONS AND ANALYSIS
==================================================

The Past Batches section should also provide analysis based on historical batch data.

Include useful correlations/analysis such as relationships between:
- FFA percentage and process selection
- Feedstock type and biodiesel yield
- Temperature and processing results
- Reaction time and output
- Stirring speed and process performance
- Other relevant recorded process parameters

The purpose is to help users understand patterns in previous biodiesel production batches.

Keep the visualizations simple, readable, and engineering-oriented.

Use charts/tables only where they provide useful information.

==================================================
11. SUCCESS / FAILURE RATE
==================================================

The Past Batches section should include historical system performance information.

Show:
- Total batches
- Successful batches
- Failed batches
- Success rate
- Failure rate

These values must be based on recorded batch data.

Do not invent fake real-world statistics.

If the system is using sample/demo data, clearly identify it as simulation/sample data.

==================================================
12. CONNECTION BETWEEN DASHBOARD AND BATCH HISTORY
==================================================

Every completed process should generate a batch record that can appear in Past Batches / Batch History.

The batch record should preserve the important process information from the Live Dashboard, including:
- Input values
- FFA result
- Selected process
- Parameters
- Timeline
- Output information
- Completion status

The system should therefore have a clear flow:

Machine Connection
→ Live Dashboard
→ Biodiesel Processing
→ Process Completion
→ Batch Record
→ Batch History
→ Historical Analysis

==================================================
13. UI/UX CONSISTENCY
==================================================

Maintain consistency across:

- Login
- Register
- Home
- Dashboard
- Live Dashboard
- Batch History
- Reports
- Machine Connection
- Settings
- Other existing pages

Use consistent:
- typography
- spacing
- card styles
- button styles
- status indicators
- colors
- icons
- navigation states

Do not introduce a completely new visual design system.

Refine the existing system instead.

==================================================
14. IMPORTANT — DO NOT CHANGE OTHER PARTS
==================================================

This is extremely important.

DO NOT modify anything outside the requirements specified in this prompt.

Do NOT:
- remove existing features
- remove existing pages
- rename unrelated navigation items
- change unrelated text
- change existing workflows that are not specified here
- redesign unrelated components
- change the application's overall structure
- remove existing functionality
- replace existing icons unnecessarily
- change the database/data structure unless required to support the specified batch-history behavior
- add unnecessary pages
- add unnecessary AI features
- add unnecessary animations
- add unnecessary decorative elements

The requested changes are specifically:

1. Replace the existing Greenova logo with the uploaded logo.
2. Make the overall dark theme less bright and less neon-green.
3. Keep green as a controlled accent color.
4. Implement/organize the authenticated machine connection flow.
5. Implement/organize the Live Dashboard process flow using the exact 12 stages specified.
6. Implement/organize Past Batches / Batch History with timelines and historical analysis.
7. Include success/failure rate based on recorded batch data.
8. Update the Login Page wording.
9. Remove visible demo credentials from the Login Page.
10. Replace "you@example.com" with a natural email placeholder.
11. Keep everything else unchanged.

==================================================
15. FINAL DESIGN DIRECTION
==================================================

The final Greenova system should feel like:

A professional dark-mode IoT biodiesel processing and monitoring platform designed for an engineering research project.

It should NOT feel like:
- an AI startup landing page
- a generic SaaS dashboard
- a cryptocurrency dashboard
- a neon-green futuristic interface
- an overly promotional commercial product

Prioritize:
- readability
- technical clarity
- process visibility
- real-time monitoring
- engineering usability
- clean dark-mode aesthetics
- restrained green accents
- clear data hierarchy

Most importantly:

DO NOT make changes beyond what is explicitly requested above.
Preserve the existing system and modify only the specified areas.