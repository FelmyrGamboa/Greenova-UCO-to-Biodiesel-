import { Link } from "react-router";
import GreenovaLogo from "../components/GreenovaLogo";
import { Card, Heading } from "../components/ui";
import { useT } from "../lib/i18n";

const workflow = [
  ["01", "Start", "Begin a new biodiesel batch."],
  ["02", "Preparation", "Prepare filtered oil, materials, and equipment."],
  ["03", "Volume & Parameters", "Enter volume and set project-defined controls."],
  ["04", "Reaction", "Run both electrochemical reaction stages."],
  ["05", "Separation", "Separate biodiesel and glycerin by centrifuge."],
  ["06", "Dry Wash & Filtration", "Purify the biodiesel with Magnesol and filter it."],
  ["07", "Complete", "Save the final batch record and results."],
];

const features = [
  ["Guided Process", "A focused, step-by-step production workflow built for operators."],
  ["Electrochemical Processing", "Supports electrochemical esterification and transesterification stages."],
  ["Live Parameters", "Follow temperature, reaction time, stirring speed, power, and stage status."],
  ["Centrifugal Separation", "Tracks the automatic separation of biodiesel and glycerin."],
  ["Batch Analytics", "Completion and lab pass rates, mean and range of yield and cost per liter per FFA range, and the proven settings."],
  ["Historical Comparison", "Compare previous batches and observe relationships in recorded data."],
];

export default function Home() {
  const t = useT();
  return (
    <div className="min-h-screen overflow-hidden bg-gv-bg text-white">
      <header className="relative z-20 flex h-20 w-full items-center justify-between px-6 sm:px-8 lg:px-10 xl:px-16">
        <Link to="/" aria-label={t("Greenova home")}>
          <GreenovaLogo size="md" />
        </Link>
        <div className="flex items-center gap-3 sm:gap-7">
          <nav className="hidden items-center gap-7 text-sm text-gray-400 md:flex">
            <a href="#about" className="transition-colors hover:text-[#01AB4A]">{t("About")}</a>
            <a href="#workflow" className="transition-colors hover:text-[#01AB4A]">{t("How It Works")}</a>
            <a href="#features" className="transition-colors hover:text-[#01AB4A]">{t("Features")}</a>
          </nav>
          <Link to="/dashboard" className="landing-cta landing-cta-nav">{t("Get Started")}</Link>
        </div>
      </header>

      <main>
        <section className="relative w-full px-6 pb-20 pt-6 sm:px-8 sm:pt-8 lg:px-10 lg:pb-24 xl:px-16">
          <div className="pointer-events-none absolute left-1/2 top-0 -z-0 h-96 w-[min(90vw,920px)] -translate-x-1/2 rounded-full bg-[#01AB4A]/[0.055] blur-3xl" />
          <div className="pointer-events-none absolute left-1/2 top-12 -z-0 h-72 w-72 -translate-x-1/2 rounded-full border border-[#01AB4A]/[0.08]" />
          <div className="relative z-10 mx-auto max-w-[1200px] text-center">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#01AB4A]/20 bg-[#01AB4A]/[0.055] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#01AB4A]">
              {t("Process control · Batch intelligence")}
            </div>
            <Heading as="h1" className="mx-auto max-w-[1120px] font-bold tracking-[-0.04em]">
              <span className="block text-5xl leading-none sm:text-6xl lg:text-[64px]">
                <span className="text-white">Green</span><span className="text-[#01AB4A]">ova</span><span className="text-white">:</span>
              </span>
              <span className="mx-auto mt-4 block text-3xl leading-[1.15] text-gray-100 sm:text-4xl lg:text-[52px]">
                <span className="block">Electrochemical Biodiesel Production</span>
                <span className="mt-1 block">with Batch Analytics and</span>
                <span className="mt-1 block">Centrifugal Separation</span>
              </span>
            </Heading>
            <p className="mx-auto mt-6 max-w-3xl text-base leading-7 text-gray-400">
              {t("A streamlined biodiesel processing platform that guides each production stage, monitors key parameters, records batch performance, and provides historical analytics for process improvement.")}
            </p>
            <div className="mt-8">
              <Link to="/dashboard" className="landing-cta landing-cta-hero">
                {t("Get Started")}
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>
          <div className="relative z-10 mt-14 grid w-full gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.07] sm:grid-cols-3">
            {[
              ["01", "Operator-guided", "Manual stage confirmation keeps the process clear and controlled."],
              ["02", "Electrochemical", "Reaction stages use the Greenova electrode and power system."],
              ["03", "Data-centered", "Every completed run becomes a comparable batch record."],
            ].map(([number, title, text]) => (
              <div key={number} className="bg-gv-surface p-6 lg:px-8">
                <div className="font-mono text-xs text-green-400">{number}</div>
                <div className="mt-5 font-display text-lg font-semibold text-white">{t(title)}</div>
                <p className="mt-2 text-sm leading-6 text-gray-500">{t(text)}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="about" className="border-y border-white/[0.06] bg-white/[0.015]">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[0.8fr_1.2fr] lg:py-28">
            <div>
              <div className="section-kicker">{t("About Greenova")}</div>
              <Heading as="h2" className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t("Control the process. Learn from every batch.")}</Heading>
            </div>
            <div className="space-y-5 text-base leading-7 text-gray-400">
              <p>
                {t("Greenova is an electrochemical biodiesel production and monitoring platform focused on process control, operator guidance, and reliable batch documentation.")}
              </p>
              <p>
                {t("It brings electrochemical production, centrifugal separation, dry-wash purification, yield tracking, and historical batch comparison into one simple operating workspace.")}
              </p>
            </div>
          </div>
        </section>

        <section id="workflow" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:py-28">
          <div className="max-w-2xl">
            <div className="section-kicker">{t("How it works")}</div>
            <Heading as="h2" className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t("One clear production path")}</Heading>
            <p className="mt-4 text-gray-500">{t("Operators always know the current stage, required action, system state, and what comes next.")}</p>
          </div>
          <div className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-7">
            {workflow.map(([step, label, desc]) => (
              <Card key={step} className="relative p-5 lg:min-h-52">
                <div className="font-mono text-xs text-green-400">{step}</div>
                <div className="mt-8 font-display text-base font-semibold text-white">{t(label)}</div>
                <p className="mt-3 text-xs leading-5 text-gray-500">{t(desc)}</p>
              </Card>
            ))}
          </div>
        </section>

        <section id="features" className="border-t border-white/[0.06] bg-white/[0.015]">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 lg:py-28">
            <div className="section-kicker">{t("Platform features")}</div>
            <Heading as="h2" className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{t("Built for credible process monitoring")}</Heading>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {features.map(([title, description], index) => (
                <Card key={title} className="p-6">
                  <div className="mb-6 flex h-9 w-9 items-center justify-center rounded-lg bg-green-500/10 font-mono text-xs text-green-400">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <div className="font-display text-lg font-semibold text-white">{t(title)}</div>
                  <p className="mt-2 text-sm leading-6 text-gray-500">{t(description)}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-8 text-xs text-gray-600 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <GreenovaLogo size="sm" />
          <div>{t("Electrochemical biodiesel process control and batch analytics.")}</div>
        </div>
      </footer>
    </div>
  );
}
