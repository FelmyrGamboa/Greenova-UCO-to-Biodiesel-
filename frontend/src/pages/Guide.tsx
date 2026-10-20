import { useState } from 'react';

const sections = [
  {
    id: 'start', title: 'Getting Started',
    content: `Log in to Greenova using your assigned credentials. You will be taken to the Dashboard, which shows the current active batch status, a process timeline, and recent batch history. Use the sidebar to navigate between sections. On mobile devices, tap the menu icon in the top-left to open the navigation panel.`,
  },
  {
    id: 'create', title: 'Creating a Batch',
    content: `Click "+ Start New Batch" from the Dashboard or sidebar. The system will generate a unique Batch ID (e.g., GV-2026-001) and initialize the 12-stage workflow. Your progress is automatically saved at each step. You can save a draft at any time and return to continue later.`,
  },
  {
    id: 'ffa', title: 'FFA Testing',
    content: `Enter the FFA (Free Fatty Acid) percentage recorded from your laboratory analysis. The system will classify the result and recommend an appropriate research-approved processing pathway. This recommendation is based on the thresholds configured by your administrator.`,
  },
  {
    id: 'process', title: 'Process Selection',
    content: `Review the recommended process pathway. Click "Accept Recommendation" to proceed, or "Override" if you need to select a different pathway. An override requires a written reason, which is recorded in the audit log.`,
  },
  {
    id: 'volume', title: 'Volume Input',
    content: `Enter the oil volume in milliliters (300–1000 mL), methanol-to-oil ratio (default 6:1, range 3:1–12:1), and catalyst-to-methanol percentage (default 1%, range 0.25–2.5 wt%). All values are validated against administrator-configured approved ranges.`,
  },
  {
    id: 'prep', title: 'Preparation Checklist',
    content: `Complete all preparation checklist items before proceeding. Each item must be checked to confirm that the corresponding preparation step has been completed. This checklist records software confirmation only — follow your approved laboratory safety protocol for all physical preparation tasks.`,
  },
  {
    id: 'params', title: 'Parameter Selection',
    content: `Select either the Default preset (60°C, 60 min, 450 RPM — research-approved values) or enter Custom parameters within the approved ranges. Custom values are validated before proceeding. A final parameter summary is displayed for confirmation.`,
  },
  {
    id: 'preheat', title: 'Oil Loading + Preheat',
    content: `The system displays the current and target temperatures. In Simulation Mode, a temperature gauge shows the simulated heating progress. Confirm readiness when the target temperature has been reached. Hardware integration will enable reading from actual temperature sensors.`,
  },
  {
    id: 'reaction', title: 'Reaction',
    content: `A progress timer and indicator show elapsed and remaining reaction time. You can Pause and Resume the reaction as needed. Stopping the reaction requires confirmation and will be recorded in the audit log. All pause and stop events are timestamped.`,
  },
  {
    id: 'separation', title: 'Separation',
    content: `The automatic separation stage displays an educational visualization of the separation layers (biodiesel and byproduct). This is a simulation for educational purposes. Observe your actual laboratory apparatus directly. Proceed when separation is complete.`,
  },
  {
    id: 'drywash', title: 'Dry Wash',
    content: `Enter the dry wash amount and number of cycles. Values are entered by the operator based on the approved laboratory procedure. The system records the entered parameters and cycle count in the batch record.`,
  },
  {
    id: 'filtration', title: 'Filtration',
    content: `The filtration and drain stages are displayed sequentially. The system tracks input volume and output container status. Confirm completion after both stages are finished.`,
  },
  {
    id: 'complete', title: 'Completing a Batch',
    content: `When all 12 stages are completed, a batch summary is displayed. You can view the batch report, download/print it, start a new batch, or return to the Dashboard. Laboratory quality results must be entered by qualified personnel — the system does not fabricate quality measurements.`,
  },
  {
    id: 'reports', title: 'Viewing Reports',
    content: `Go to the Reports section from the sidebar. Select an individual completed batch to generate a detailed report including batch information, FFA results, parameter summary, stage timeline, and notes. A Production Summary is also available showing aggregate statistics. Reports can be printed or exported as PDF.`,
  },
  {
    id: 'trouble', title: 'Troubleshooting',
    content: `If the system shows "Simulation Mode", it means hardware sensors are not connected. This is expected when demonstrating the software without laboratory equipment. Check that your internet connection is stable. If a batch appears stuck, use the "Save Draft" option and refresh the page. Contact your administrator if you encounter access issues or need to reset a batch status.`,
  },
];

export default function Guide() {
  const [open, setOpen] = useState<string | null>('start');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="font-display font-bold text-2xl text-white">System Guide</h1>
        <p className="text-gray-500 text-sm mt-0.5">How to use the Greenova monitoring software</p>
      </div>

      <div className="glass rounded-xl p-4 border border-yellow-500/15">
        <div className="text-yellow-400 text-xs font-semibold mb-1">Important Notice</div>
        <p className="text-gray-500 text-xs">
          This guide explains how to use the Greenova software. It does not replace laboratory safety procedures.
          For chemical handling and process-specific instructions, follow your approved laboratory and research protocol.
        </p>
      </div>

      <div className="space-y-2">
        {sections.map((s, i) => (
          <div key={s.id} className="glass rounded-2xl overflow-hidden">
            <button
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className="w-full flex items-center gap-4 p-4 text-left hover:bg-white/[0.02] transition-colors"
            >
              <div className="w-7 h-7 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center flex-shrink-0">
                <span className="font-mono text-green-400 text-xs font-bold">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <span className="font-medium text-white text-sm flex-1">{s.title}</span>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`w-4 h-4 text-gray-500 transition-transform ${open === s.id ? 'rotate-180' : ''}`}
              >
                <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
            {open === s.id && (
              <div className="px-4 pb-4 text-sm text-gray-400 leading-relaxed border-t fade-in" style={{ borderColor: 'rgba(34,197,94,0.08)' }}>
                <div className="pt-4">{s.content}</div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
