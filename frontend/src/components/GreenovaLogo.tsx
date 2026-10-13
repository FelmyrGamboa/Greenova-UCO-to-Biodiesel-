interface GreenovaLogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

export default function GreenovaLogo({ size = "md", className = "" }: GreenovaLogoProps) {
  const sizes = {
    sm: "text-xl",
    md: "text-2xl",
    lg: "text-3xl",
  };

  return (
    <div
      aria-label="Greenova"
      className={`inline-flex shrink-0 items-baseline font-display font-extrabold leading-none tracking-[-0.045em] ${sizes[size]} ${className}`}
    >
      <span className="greenova-logo-green">Green</span>
      <span className="greenova-logo-ova">ova</span>
    </div>
  );
}
