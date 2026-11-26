import { HardDrive } from 'lucide-react';
import { formatBytes } from '../i18n';

interface StorageQuotaBarProps {
  usedBytes: number;
  limitBytes: number;
  isAuthenticated: boolean;
  onUpgradeClick?: () => void;
  t: Record<string, string>;
}

export function StorageQuotaBar({
  usedBytes,
  limitBytes,
  isAuthenticated,
  onUpgradeClick,
  t,
}: StorageQuotaBarProps) {
  const safeLimit = limitBytes > 0 ? limitBytes : (isAuthenticated ? 10 : 5) * 1024 * 1024 * 1024;
  const safeUsed = Math.max(0, usedBytes);
  const limitGb = Math.max(1, Math.round(safeLimit / (1024 * 1024 * 1024)));

  const rawPercent = (safeUsed / safeLimit) * 100;
  const clampedPercent = Math.min(100, Math.max(0, rawPercent));
  const barWidthPct = safeUsed > 0 ? Math.max(2, Math.round(clampedPercent * 10) / 10) : 0;
  const displayPercent = safeUsed > 0 && clampedPercent < 1 ? '<1' : Math.round(clampedPercent).toString();

  const usedFormatted = safeUsed === 0 ? '0 GB' : formatBytes(safeUsed);
  const summaryTemplate = t.storage_used_of || '{used} of {limit} GB used';
  const summaryText = summaryTemplate
    .replace('{used}', usedFormatted)
    .replace('{limit}', String(limitGb));

  const fillColorClass =
    clampedPercent >= 95
      ? 'bg-gradient-to-r from-red-500 to-rose-400'
      : clampedPercent >= 75
        ? 'bg-gradient-to-r from-amber-500 to-amber-400'
        : 'bg-gradient-to-r from-cyan-500 to-cyan-400';

  return (
    <div className="mb-4 rounded-xl bg-[#090f19]/80 border border-white/[0.08] px-4 py-3.5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
          <HardDrive className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span>{isAuthenticated ? t.drawer_storage_plan_registered : t.drawer_storage_plan}</span>
        </div>

        <div className="flex items-center gap-2.5 text-xs tabular-nums">
          <span className="text-slate-300 font-medium">{summaryText}</span>
          <span className="text-[11px] text-slate-400">({displayPercent}%)</span>
        </div>
      </div>

      <div
        role="progressbar"
        aria-label={t.drawer_storage_title}
        aria-valuenow={Math.round(clampedPercent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="w-full h-2 rounded-full bg-white/[0.08] overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${fillColorClass}`}
          style={{ width: `${barWidthPct}%` }}
        />
      </div>

      {!isAuthenticated && onUpgradeClick && (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={onUpgradeClick}
            className="text-[11px] font-medium text-cyan-400 hover:text-cyan-300 transition-colors cursor-pointer"
          >
            {t.drawer_storage_upgrade} →
          </button>
        </div>
      )}
    </div>
  );
}
