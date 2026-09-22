============================================================
GREENOVA — COMPLETE WEB APPLICATION MASTER PROMPT
============================================================

PROJECT NAME:
GREENOVA

PROJECT TITLE:
Automated Biodiesel Process Monitoring System

PROJECT TYPE:
Responsive Web-Based Biodiesel Process Monitoring and Management System

============================================================
1. PROJECT OVERVIEW
============================================================

Create a fully functional web application called GREENOVA.

Greenova is a web-based monitoring and management system designed for small-scale biodiesel production research.

The main purpose of Greenova is to help users:

- Create and manage biodiesel production batches
- Record FFA testing results
- Select a research-approved processing pathway
- Enter and validate batch information
- Follow preparation checklists
- Select approved process parameters
- Monitor the biodiesel production process
- Track the current production stage
- Monitor available sensor or simulation data
- Record process events
- View completed batches
- Review batch history
- Generate production reports
- Maintain organized records
- Provide administrators with system configuration and monitoring tools

The application must be FUNCTIONAL, not just a visual prototype.

Buttons must work.
Forms must work.
Navigation must work.
Authentication must work.
Batch records must be saved.
Process progress must be saved.
Data must persist.
Reports must be generated.
Validation must work.
Responsive layouts must work.

IMPORTANT SAFETY / RESEARCH REQUIREMENT:

Greenova is a monitoring and research-management system.

Do NOT invent chemical recipes, hazardous operating instructions, unsafe quantities, or unsupported process parameters.

Any chemical quantities, temperatures, reaction times, ratios, stirring speeds, thresholds, or other process-specific values must come from administrator/researcher-configured values or approved research presets.

The system may DISPLAY approved values, validate entered values against configured ranges, and record process data.

The application must not autonomously invent chemical instructions.

If actual laboratory or hardware values are unavailable, clearly label the information as:
"Simulation Mode"
or
"Not Connected"

Never present simulated data as real sensor measurements.

============================================================
2. DESIGN AND VISUAL IDENTITY
============================================================

Use the provided Greenova login-page screenshot as the PRIMARY visual reference.

The entire application must use the same visual identity as the screenshot.

BRAND:

GREENOVA

Subtitle:

Automated Biodiesel Process Monitoring System

Suggested description:

"Greenova helps small-scale biodiesel producers monitor and optimize their process in real time for better quality, efficiency, and sustainability."

VISUAL STYLE:

Modern environmental technology + industrial monitoring system + sustainable energy platform.

COLOR DIRECTION:

- Near-black
- Deep forest green
- Dark green
- Leaf green
- Lime green
- Subtle yellow-green accents
- White typography
- Light gray secondary text

BACKGROUND:

Use dark green/black backgrounds with:

- Subtle gradients
- Organic flowing shapes
- Green glowing effects
- Very subtle particles
- Soft environmental/energy-inspired patterns

Do not make the background overly bright or distracting.

CARDS:

Use:

- Dark translucent surfaces
- Glassmorphism
- Thin green borders
- Soft green glow
- Moderate rounded corners
- Subtle shadows

INPUTS:

- Dark translucent background
- Thin gray/green border
- Rounded corners
- White text
- Muted placeholder text
- Clear focus state

BUTTONS:

Primary buttons should use Greenova green.

Use subtle hover effects:

- Slight brightness increase
- Soft glow
- Smooth transition

TYPOGRAPHY:

Use a modern sans-serif font such as:

- Inter
- Manrope
- or another similar professional font

TEXT HIERARCHY:

Large white headings.
Green accent words.
Light gray descriptions.
Green status indicators.

ICONS:

Use clean modern line icons related to:

- Dashboard
- Production
- Temperature
- Process
- Reports
- Users
- Settings
- Alerts
- Environment

Do not overuse icons.

ANIMATIONS:

Use subtle professional animations only:

- Fade in
- Slide up
- Smooth transitions
- Progress animations
- Status pulse
- Hover effects

Do not make the application look like a gaming interface.

The final UI should look professional enough for a university research project, thesis/capstone presentation, and actual prototype demonstration.

============================================================
3. RESPONSIVE DESIGN
============================================================

The entire application must be fully responsive.

Support:

1. Desktop
2. Laptop
3. Tablet
4. Mobile phone

DESKTOP:

- Persistent sidebar
- Multi-column dashboard
- Full-width monitoring sections
- Full tables
- Charts
- Large process visualization

LAPTOP:

- Slightly reduced spacing
- Persistent or collapsible sidebar
- Maintain readability

TABLET:

- Collapsible sidebar
- Two-column layouts where appropriate
- Stack forms when necessary
- Responsive charts

MOBILE:

- Hamburger menu
- Optional bottom navigation
- Single-column layout
- Large touch-friendly controls
- Sticky process status
- Responsive forms
- Horizontally scrollable tables or responsive cards

IMPORTANT:

Do not simply shrink the desktop design.

Create proper responsive layouts.

Test the interface at approximately:

320px
375px
390px
768px
1024px
1280px
1440px+

Prevent:

- Horizontal page overflow
- Cropped buttons
- Overlapping elements
- Broken charts
- Tiny text
- Tiny touch targets

============================================================
4. APPLICATION STRUCTURE
============================================================

PUBLIC / NOT AUTHENTICATED:

/
    Home

/login
    Login

/register
    Registration

/forgot-password
    Password Recovery

/about
    Research/About Greenova


AUTHENTICATED:

/dashboard
    Main Dashboard

/batch/new
    New Biodiesel Batch

/batches
    Batch History

/batches/[batchId]
    Batch Details

/reports
    Reports

/monitor
    Live Process Monitoring

/notifications
    Notifications

/guide
    System Guide

/profile
    User Profile

/settings
    Settings


ADMIN:

/admin
    Administrator Dashboard

/admin/users
    User Management

/admin/configuration
    Process Configuration

/admin/logs
    System Logs

Only authorized administrator accounts can access administrator pages.

============================================================
5. PUBLIC HOME PAGE
============================================================

Create a professional Greenova landing page.

HERO:

GREENOVA

Automated Biodiesel Process Monitoring System

"Smart monitoring for cleaner, more efficient, and sustainable biodiesel production."

Buttons:

[Get Started]

[Login]

Include an environmental/biodiesel-themed illustration that matches the Greenova branding.

SECTIONS:

1. About Greenova
2. Research Background
3. System Objectives
4. How Greenova Works
5. Key Features
6. Sustainability Focus
7. Call to Action

The page should explain the research project clearly without exposing private user or batch information.

============================================================
6. LOGIN PAGE
============================================================

Recreate the provided Greenova login screenshot as closely as practical while improving responsiveness.

DESKTOP LAYOUT:

LEFT PANEL:

- Greenova logo
- GREENOVA title
- "Automated Biodiesel Process Monitoring System"
- Research description
- Biodiesel/environment illustration
- Organic green glowing background

RIGHT PANEL:

Authentication card.

Heading:

"Welcome Back!"

Subheading:

"Login to continue to Greenova"

FIELDS:

Email Address

Password

Password field must have a show/hide password button.

LINK:

Forgot password?

PRIMARY BUTTON:

Login

DIVIDER:

OR

GOOGLE AUTHENTICATION:

Sign in with Google

BOTTOM:

"Don't have an account? Register here"

FOOTER:

© 2026 Greenova. All rights reserved.

FUNCTIONALITY:

- Email validation
- Required field validation
- Authentication loading state
- Authentication errors
- Successful login redirect to Dashboard
- Protected routes
- Logout functionality

============================================================
7. REGISTER PAGE
============================================================

Create:

"Create your Greenova Account"

FIELDS:

Full Name
Email Address
Password
Confirm Password

CHECKBOX:

"I agree to the Terms and Privacy Policy"

BUTTON:

[Create Account]

DIVIDER:

OR

BUTTON:

[Continue with Google]

BOTTOM:

"Already have an account? Login"

VALIDATION:

- Required fields
- Valid email
- Password requirements
- Password confirmation
- Terms agreement

Never display or expose passwords.

============================================================
8. FORGOT PASSWORD
============================================================

Create a password recovery page.

Heading:

"Forgot your password?"

Description:

"Enter your email address and we'll help you recover your account."

FIELD:

Email Address

BUTTON:

[Send Reset Link]

Display appropriate success and error messages.

============================================================
9. AUTHENTICATED NAVIGATION
============================================================

Use a clean sidebar.

SIDEBAR:

GREENOVA logo

Navigation:

Dashboard

+ New Batch

Batch History

Reports

Settings

--------------------------------

Profile

Logout

IMPORTANT:

Do NOT create too many navigation items.

The dashboard should remain focused.

The active production process should be accessible from the Dashboard and New Batch workflow.

Do not create a separate unnecessary "Active Process" navigation item.

============================================================
10. MAIN DASHBOARD
============================================================

The dashboard should be SIMPLE and focused.

Do NOT overload it with too many analytics cards.

The dashboard should focus on:

1. What is happening now?
2. Where is the current batch in the process?
3. What happened recently?

ROUTE:

/dashboard

HEADER:

"Good day, [User Name]"

"Monitor your biodiesel production process."

Primary button:

[+ Start New Batch]

--------------------------------
SUMMARY CARDS
--------------------------------

Only 4 cards:

1. Active Batch
2. Completed Batches
3. Total Batches
4. System Status

Do not add unnecessary dashboard cards.

--------------------------------
CURRENT ACTIVE BATCH
--------------------------------

This is the MOST IMPORTANT dashboard section.

If an active batch exists:

Display:

CURRENT BATCH

Batch ID:
GV-2026-001

Process:
[Selected Process]

Status:
● In Progress

Current Stage:
REACTION

Progress:
65%

Elapsed Time:
01:24:35

Button:

[Continue Process]

If there is no active batch:

Display:

NO ACTIVE BATCH

"Start a new biodiesel production batch."

Button:

[+ Start New Batch]

--------------------------------
PROCESS TIMELINE
--------------------------------

Display the 12 production stages:

✓ Start
✓ FFA Testing
✓ Process Selection
✓ Volume Input
✓ Preparation
● Parameter Selection
○ Oil Loading + Preheat
○ Reaction
○ Automatic Separation
○ Dry Wash
○ Filtration + Drain
○ Complete

Use:

Green = completed
Bright green = current
Muted gray = upcoming

Keep the timeline visually compact.

--------------------------------
LIVE MONITORING
--------------------------------

Show only important current parameters.

Examples:

Temperature
Stirring Speed
Process Progress
Process Status

Example:

Temperature:
[Configured/Recorded Value]

Stirring:
[Configured/Recorded Value]

Progress:
65%

Status:
● Running

If no hardware is connected:

"Simulation Mode"

Never pretend simulated data is real.

--------------------------------
RECENT BATCHES
--------------------------------

Show only the latest 5 batches.

Columns:

Batch ID
Process
Status
Date
Action

Action:

[View]

Button:

[View All]

The dashboard should remain clean and uncluttered.

============================================================
11. NEW BATCH WORKFLOW
============================================================

ROUTE:

/batch/new

Use a multi-step wizard.

Display at the top:

NEW BIODIESEL BATCH

Step X of 12

Progress indicator.

Buttons:

[Back]
[Save Draft]
[Continue]

Save entered information between steps.

Do not allow required steps to be skipped.

The workflow must follow exactly these 12 stages:

1. Start
2. FFA Testing
3. Process Selection
4. Volume Input
5. Preparation Instruction
6. Parameter Selection
7. Oil Loading + Preheat
8. Reaction Stage
9. Automatic Separation
10. Dry Wash Input
11. Filtration + Drain
12. Complete

============================================================
12. STEP 1 — START
============================================================

Title:

"Start Process"

Create a unique Batch ID.

Display:

Batch ID
Date/Time
User
Process Status

Button:

[Start Process]

When clicked:

- Create batch record
- Set status to Ready
- Save timestamp
- Move to FFA Testing

============================================================
13. STEP 2 — FFA TESTING
============================================================

Title:

"FFA Testing"

Explain:

"The FFA test result is used to determine the appropriate research-approved processing pathway."

Display:

FFA Test Status

Options:

Not Started
Testing
Complete

Input:

FFA Test Result

Allow the researcher/operator to enter the recorded result.

After submission display:

FFA Result

Classification:

[Based on administrator-configured rules]

Recommended Process:

[Research-approved configured process]

Do NOT invent the classification rules.

The rules must be configurable by authorized research personnel.

Button:

[Confirm Result]

Save:

- FFA result
- Classification
- Timestamp
- User

============================================================
14. STEP 3 — PROCESS SELECTION
============================================================

Title:

"Process Selection"

Display:

Recommended Process

Reason:

"Based on the recorded FFA test result and configured research criteria."

Buttons:

[Accept Recommendation]

[Override]

If Override is selected:

Require:

Override Reason

Save the override in the audit log.

============================================================
15. STEP 4 — VOLUME INPUT
============================================================

Title:

"Volume Input"

Fields:

Oil Volume - accept input from 300–1000 mL of oil
Methanol to Oil Ratio - Default (6:1), but can input from 3:1 - 12:1
Catalyst to Methanol Percentage - Default (1%), but can input from 0.25–2.5 wt%

Unit:

Oil Volume = mL

Validate:

- Numeric value
- Positive value
- Configured approved range

Display:

Batch Volume
Selected Process
Calculation Status

If outside the approved range:

"Value outside approved range."

Do not invent chemical ratios.

Any calculation must use administrator/researcher-configured formulas.

============================================================
16. STEP 5 — PREPARATION INSTRUCTION
============================================================

Title:

"Preparation Checklist"

Create a checklist based on the selected approved process.

Example checklist items:

☐ Required preparation completed
☐ Required materials verified
☐ Catalyst preparation confirmed
☐ Required mixing preparation confirmed
☐ Work area checked

Include the research workflow confirmation:

"Confirm catalyst mixed with methanol"

Do not provide hazardous handling instructions or unsupported quantities.

Require checklist completion before proceeding.

Button:

[Confirm Preparation]

Save:

- Checklist status
- User
- Timestamp

============================================================
17. STEP 6 — PARAMETER SELECTION
============================================================

Title:

"Parameter Selection"

Provide:

[Default]
[Custom]

DEFAULT:

60 degrees celsius - Temperature Target
60 minutes - Reaction Duration
450 RPM - Stirring Speed

Load administrator/researcher-approved validated values.

Display:

Temperature Target
Reaction Duration
Stirring Speed
Other configured parameters

Label:

"Research-approved preset"

CUSTOM:

For Temperature Target, 40–70°C only
For Reaction Duration, 20–180 min only
For Stirring Speed - 150–900 RPM only

Allow authorized users to enter custom values.

Validate every value against administrator-configured approved ranges.

If invalid:

"Parameter outside approved research range."

Require correction.

Display a final parameter summary.

============================================================
18. STEP 7 — OIL LOADING + PREHEAT
============================================================

Title:

"Oil Loading + Preheat"

Display:

Oil Volume
Target Temperature
Current Temperature
Elapsed Time
Process Status

Create a large monitoring visualization.

Example:

CURRENT
[Value]

TARGET
[Configured Value] - 

Create a temperature gauge.

Statuses:

Heating
Ready
Warning
Not Connected

If no hardware exists:

"Simulation Mode — Hardware connection unavailable."

Never claim actual sensor readings without actual hardware.

Button:

[Confirm Ready]

============================================================
19. STEP 8 — REACTION STAGE
============================================================

Title:

"Reaction Stage"

Display:

Process:
[Selected Process]

Status:
Running

Elapsed Time

Configured Duration

Temperature Status

Stirring Status

Create a visual progress indicator.

Example:

REACTION PROGRESS

████████████░░░░░░

Show:

Elapsed Time
Remaining Time

Controls:

[Pause]
[Resume]
[Stop Process]

Stopping requires confirmation.

Every pause, resume, and stop event must be saved to the audit log.

============================================================
20. STEP 9 — AUTOMATIC SEPARATION
============================================================

Title:

"Automatic Separation"

Display:

Status:

Separating...

Create an educational visual showing simplified separation layers:

Biodiesel Layer
Byproduct Layer

Do not provide hazardous chemical handling instructions.

When complete:

"Separation Complete"

Button:

[Continue]

Save timestamp and status.

============================================================
21. STEP 10 — DRY WASH INPUT
============================================================

Title:

"Dry Wash"

Allow users to enter approved dry-wash parameters.

Possible fields:

Dry Wash Amount
Number of Cycles
Other configured parameters

Do not automatically invent chemical quantities.

Validate all inputs.

Display:

Dry Wash Status
Configured Parameters
Current Cycle

Button:

[Start Dry Wash]

============================================================
22. STEP 11 — FILTRATION + DRAIN
============================================================

Title:

"Filtration + Drain"

Display two stages:

1. Filtering
2. Draining

Statuses:

Filtering...
Draining...
Complete

Create a visual progress indicator.

Display:

Input Batch Volume
Processed Volume
Output Container Status

If hardware is unavailable:

"Simulation Mode"

Require confirmation before completion.

============================================================
23. STEP 12 — COMPLETE
============================================================

Title:

"Process Complete"

Display:

Large success icon:

✓

"Process Complete"

Batch Summary:

Batch ID
Date
User
Selected Process
Initial Volume
FFA Result
Process Duration
Final Status

Do NOT fabricate laboratory quality measurements.

If no quality testing data exists:

"Quality testing pending."

Buttons:

[View Batch Report]

[Download Report]

[Start New Batch]

[Back to Dashboard]

Save the completed batch permanently.

============================================================
24. LIVE PROCESS MONITORING
============================================================

ROUTE:

/monitor

Display the currently active batch.

HEADER:

LIVE PROCESS MONITORING

Batch:
GV-2026-001

Status:
● PROCESS RUNNING

Show the complete 12-stage process timeline.

Highlight the current stage.

LIVE PARAMETERS:

Temperature
Stirring Speed
Elapsed Time
Process Progress
System State

Create real-time charts where actual data exists.

Possible charts:

Temperature vs Time
Stirring Speed vs Time
Process Progress vs Time

If data is simulated:

Clearly display:

"Simulation Data"

Never misrepresent simulation data as actual sensor readings.

============================================================
25. ALERT SYSTEM
============================================================

Create an alert system.

Alert categories:

Normal
Warning
Critical
Disconnected

Thresholds must be administrator-configured.

Each alert contains:

Parameter
Severity
Message
Timestamp
Batch

Examples of UI states:

● Normal
▲ Warning
! Critical
○ Disconnected

Store alerts in the event log.

============================================================
26. BATCH HISTORY
============================================================

ROUTE:

/batches

Display all batches accessible to the authenticated user.

TABLE:

Batch ID
Date
Process
FFA Result
Initial Volume
Duration
Status
Action

Statuses:

Draft
Ready
In Progress
Paused
Completed
Stopped
Error

Actions:

[View]
[Edit Draft]
[Report]

FILTERS:

Date
Status
Process
FFA Result

SEARCH:

Search by Batch ID.

============================================================
27. BATCH DETAILS
============================================================

ROUTE:

/batches/[batchId]

Display complete batch information.

Sections:

Batch Information
Process Information
FFA Testing
Parameters
Process Timeline
Sensor Data
Alerts
Notes
Audit Log

Display every stage:

1. Start
2. FFA Testing
3. Process Selection
4. Volume Input
5. Preparation
6. Parameters
7. Preheat
8. Reaction
9. Separation
10. Dry Wash
11. Filtration
12. Complete

For each stage display:

Status
Timestamp
Recorded values
Notes
User action

============================================================
28. REPORTS
============================================================

ROUTE:

/reports

Create:

1. Individual Batch Report
2. Batch Summary Report
3. Production History
4. Process Performance Summary

INDIVIDUAL REPORT:

GREENOVA

Biodiesel Production Monitoring Report

Include:

Batch Information
Process Information
FFA Test
Parameter Summary
Stage Timeline
Process Duration
Completion Status
Notes
Laboratory Quality Results if available

Clearly distinguish:

System-recorded data
Researcher-entered data
Laboratory test results
Simulated sensor data

Buttons:

[Generate PDF]
[Print]
[Export]

SUMMARY REPORT:

Display:

Total Batches
Completed Batches
Stopped Batches
Average Process Duration
Total Recorded Oil Volume
Most Used Process
Recent Activity

Use clean charts.

Never fabricate missing data.

============================================================
29. NOTIFICATIONS
============================================================

Create:

/notifications

Notification categories:

Process Update
Process Complete
Parameter Warning
System Warning
Batch Saved
Report Generated
System Connection

Each notification includes:

Title
Message
Timestamp
Severity
Read/Unread status

Actions:

[Mark as Read]
[Mark All as Read]

============================================================
30. SYSTEM GUIDE
============================================================

ROUTE:

/guide

Create an educational software guide.

Sections:

1. Getting Started
2. Creating a Batch
3. FFA Testing
4. Process Selection
5. Volume Input
6. Preparation Checklist
7. Parameter Selection
8. Oil Loading + Preheat
9. Reaction
10. Separation
11. Dry Wash
12. Filtration
13. Completing a Batch
14. Viewing Reports
15. Troubleshooting

IMPORTANT:

The guide explains how to USE THE SOFTWARE.

It does not replace laboratory safety procedures.

For chemical/process-specific instructions:

"Follow your approved laboratory/research protocol."

============================================================
31. USER PROFILE
============================================================

ROUTE:

/profile

Display:

Profile Picture
Full Name
Email
Role
Account Created

Sections:

Personal Information
Account Security
Notification Preferences

Buttons:

[Edit Profile]
[Change Password]
[Logout]

============================================================
32. SETTINGS
============================================================

ROUTE:

/settings

Sections:

Appearance
Notifications
System Preferences
Data Preferences

Appearance options:

Dark Green Theme
Light Theme
System Default

Greenova Dark Green should remain the primary branded theme.

Other configurable settings:

Notification preferences
Measurement units
Dashboard preferences
Language if implemented

============================================================
33. ADMINISTRATOR SYSTEM
============================================================

Create an Administrator role.

Admin Dashboard:

/admin

Only authorized administrators can access it.

ADMIN DASHBOARD CARDS:

Total Users
Active Users
Total Batches
Completed Batches
Active Processes
System Alerts

Keep the admin dashboard simple.

============================================================
34. USER MANAGEMENT
============================================================

Route:

/admin/users

Admin can:

- View Users
- Create User
- Deactivate User
- Change Role
- View User Activity

ROLES:

Administrator
Researcher
Operator

Implement role-based permissions.

============================================================
35. PROCESS CONFIGURATION
============================================================

Route:

/admin/configuration

Authorized administrators/researchers can configure:

Approved Process Types
Approved Parameter Ranges
Default Presets
Validation Rules
FFA Classification Rules
Process Stage Durations
Alert Thresholds

IMPORTANT:

Do NOT hard-code unsafe chemical recipes.

Process-specific values must be configurable by authorized research personnel.

Every configuration change must record:

Who changed it
What changed
Old value
New value
Date/time
Reason

============================================================
36. SYSTEM LOGS / AUDIT LOG
============================================================

Route:

/admin/logs

Track:

Login Events
Logout Events
Batch Creation
Batch Updates
Parameter Changes
Process Events
Warnings
Errors
Configuration Changes
Report Generation
User Changes

Allow filtering by:

User
Date
Event Type
Batch
Severity

============================================================
37. DATABASE STRUCTURE
============================================================

Create a relational database.

USERS:

id
full_name
email
role
profile_image
created_at
updated_at
account_status

BATCHES:

id
batch_code
user_id
status
process_type
initial_volume
ffa_result
started_at
completed_at
duration
created_at
updated_at

PROCESS_STAGES:

id
batch_id
stage_number
stage_name
status
started_at
completed_at
notes

PROCESS_PARAMETERS:

id
batch_id
parameter_name
parameter_value
unit
source
recorded_at

FFA_TESTS:

id
batch_id
result
unit
classification
recorded_by
recorded_at

SENSOR_READINGS:

id
batch_id
sensor_type
value
unit
timestamp
data_source

PROCESS_ALERTS:

id
batch_id
parameter
severity
message
timestamp
acknowledged

PREPARATION_CHECKLIST:

id
batch_id
checklist_item
completed
completed_by
completed_at

BATCH_NOTES:

id
batch_id
user_id
note
created_at

AUDIT_LOGS:

id
user_id
batch_id
event_type
description
timestamp

SYSTEM_CONFIG:

id
config_name
config_value
category
updated_by
updated_at

REPORTS:

id
batch_id
report_type
generated_by
generated_at
file_reference

============================================================
38. DATA VALIDATION
============================================================

Implement comprehensive validation.

Required fields must be validated.

Numeric fields must accept numeric values only.

Positive values must be enforced where appropriate.

Configured process ranges must be enforced.

Invalid values must produce clear messages.

Example:

"Value outside the approved research range."

Do not allow invalid process data to silently continue.

============================================================
39. PROCESS STATE MANAGEMENT
============================================================

Each batch must have a clear status.

Possible batch statuses:

Draft
Ready
In Progress
Paused
Completed
Stopped
Error

Each process stage must have a state:

Pending
Current
Completed
Skipped only when explicitly allowed
Error

Do not allow arbitrary stage skipping.

The system must remember the user's current position if they leave and return to a saved batch.

============================================================
40. LOADING / ERROR / EMPTY STATES
============================================================

Every page must have appropriate:

Loading state
Empty state
Error state
Success state

Examples:

Loading:

"Loading batch data..."

Empty:

"No batches found."

Error:

"Unable to load batch data. Please try again."

Success:

"Batch saved successfully."

Use Greenova visual styling for notifications.

============================================================
41. SECURITY
============================================================

Implement:

- Secure authentication
- Protected routes
- Role-based access
- Secure password handling
- User authorization
- Database access control
- Audit logging

Users should only access information they are authorized to access.

Do not expose passwords.

Do not expose private account information.

============================================================
42. SIMULATION MODE
============================================================

Because the application may initially be demonstrated without physical sensors, implement a clearly labeled Simulation Mode.

Simulation mode can demonstrate:

- Temperature changes
- Process progress
- Timer
- Stage transitions
- Status updates

The UI must always show:

SIMULATION MODE

when values are simulated.

Do not make simulated data look like verified laboratory measurements.

If physical hardware is connected later, allow the data source to change from:

Simulation

to:

Live Sensor

============================================================
43. FUTURE HARDWARE INTEGRATION
============================================================

Structure the application so that actual sensors/controllers can be connected later.

Potential data sources:

- Temperature sensor
- Stirring/motor status
- Process controller
- Other approved monitoring sensors

Create a clear data-source abstraction:

Simulation
Live Sensor
Manual Entry

Display the data source beside important readings.

============================================================
44. DASHBOARD SIMPLICITY REQUIREMENT
============================================================

IMPORTANT:

DO NOT OVERLOAD THE DASHBOARD.

Only display:

1. Four summary cards
2. Current active batch
3. Process timeline
4. Live monitoring
5. Recent batches

Do NOT place all features on the dashboard.

The dashboard should answer three questions:

"What is happening now?"

"Where is the batch in the process?"

"What happened recently?"

Other functionality should be accessible through navigation.

============================================================
45. UI COMPONENTS
============================================================

Create reusable components for:

- Sidebar
- Top navigation
- Buttons
- Cards
- Input fields
- Select fields
- Modal dialogs
- Confirmation dialogs
- Toast notifications
- Status badges
- Progress bars
- Process timeline
- Monitoring cards
- Charts
- Tables
- Empty states
- Loading states
- Error states
- Date/time displays
- Report layouts

Maintain consistent styling across the entire application.

============================================================
46. ACCESSIBILITY
============================================================

Implement basic accessibility:

- Readable text
- Proper contrast
- Keyboard navigation
- Visible focus states
- Labels for inputs
- Accessible buttons
- Accessible status indicators
- Do not rely on color alone to communicate status

============================================================
47. FINAL USER FLOW
============================================================

The primary user experience should be:

PUBLIC:

Home
  ↓
Login / Register
  ↓
Dashboard

AUTHENTICATED:

Dashboard
  ↓
Start New Batch
  ↓
1. Start
  ↓
2. FFA Testing
  ↓
3. Process Selection
  ↓
4. Volume Input
  ↓
5. Preparation
  ↓
6. Parameter Selection
  ↓
7. Oil Loading + Preheat
  ↓
8. Reaction
  ↓
9. Automatic Separation
  ↓
10. Dry Wash
  ↓
11. Filtration + Drain
  ↓
12. Complete
  ↓
Batch Report
  ↓
Batch History
  ↓
Dashboard

============================================================
48. FINAL QUALITY REQUIREMENTS
============================================================

Before considering the application complete, perform a full functionality review.

TEST AUTHENTICATION:

- Register
- Login
- Logout
- Forgot password
- Google authentication if configured
- Protected routes

TEST BATCH SYSTEM:

- Create batch
- Save draft
- Continue batch
- Pause batch
- Resume batch
- Stop batch
- Complete batch
- View batch
- View history
- Generate report

TEST PROCESS:

- Start
- FFA Testing
- Process Selection
- Volume Input
- Preparation
- Parameter Selection
- Oil Loading + Preheat
- Reaction
- Separation
- Dry Wash
- Filtration + Drain
- Complete

TEST DATA:

- Save records
- Load records
- Update records
- Maintain timestamps
- Maintain audit history

TEST VALIDATION:

- Required fields
- Invalid email
- Invalid numeric input
- Empty input
- Out-of-range values
- Invalid process parameters

TEST UI:

- Loading states
- Empty states
- Error states
- Success messages
- Confirmation dialogs

TEST RESPONSIVENESS:

- Desktop
- Laptop
- Tablet
- Mobile

Fix all:

- Broken buttons
- Broken links
- Broken navigation
- Overflow
- Layout problems
- Missing states
- Validation problems
- Console errors

============================================================
49. FINAL DESIGN GOAL
============================================================

The final application should feel like a REAL BIODIESEL PROCESS MONITORING SYSTEM.

It should NOT look like:

- A generic CRUD dashboard
- A generic business website
- A generic admin template
- A simple calculator
- A collection of disconnected mockup pages

It should feel like:

GREENOVA

A modern environmental technology platform for monitoring and managing small-scale biodiesel production.

The most important experience should be:

AUTHENTICATE
    ↓
DASHBOARD
    ↓
CREATE BATCH
    ↓
FFA TEST
    ↓
PROCESS SELECTION
    ↓
INPUT / VALIDATE
    ↓
PREPARATION
    ↓
MONITOR
    ↓
COMPLETE
    ↓
REPORT
    ↓
HISTORY

Keep the interface clean, professional, research-oriented, and easy to demonstrate.

Use the provided Greenova screenshot as the primary visual reference for the color scheme, typography, glassmorphism, borders, green glow, and overall aesthetic.

DO NOT add unnecessary features simply to make the application larger.

Prioritize:

FUNCTIONALITY
CLARITY
PROCESS MONITORING
DATA ACCURACY
RESPONSIVENESS
RESEARCH PRESENTATION
SAFETY
PROFESSIONAL DESIGN

============================================================
END OF GREENOVA MASTER PROMPT
============================================================


