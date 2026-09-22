import logoSrc from '../assets/logo.png';

interface GreenovaLogoProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function GreenovaLogo({ size = 'md', className = '' }: GreenovaLogoProps) {
  const heights: Record<string, number> = { sm: 22, md: 28, lg: 36 };
  const h = heights[size];
  return (
    <img
      src={logoSrc}
      alt="Greenova"
      height={h}
      style={{ height: h, width: 'auto', display: 'block' }}
      className={className}
    />
  );
}
