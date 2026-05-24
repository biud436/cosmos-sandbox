export function formatCosmicTime(years: number): string {
  if (!Number.isFinite(years)) return '—';
  const sign = years < 0 ? '-' : '';
  const v = Math.abs(years);

  if (v < 1) return `${sign}${v.toFixed(2)} 년`;
  if (v < 10_000) return `${sign}${Math.floor(v).toLocaleString('ko-KR')} 년`;
  if (v < 100_000_000) {
    const x = v / 10_000;
    return `${sign}${fmt(x)} 만 년`;
  }
  if (v < 1_000_000_000_000) {
    const x = v / 100_000_000;
    return `${sign}${fmt(x)} 억 년`;
  }
  const x = v / 1_000_000_000_000;
  return `${sign}${fmt(x)} 조 년`;
}

function fmt(x: number): string {
  if (x < 10) return x.toFixed(2);
  if (x < 100) return x.toFixed(1);
  return Math.round(x).toLocaleString('ko-KR');
}
