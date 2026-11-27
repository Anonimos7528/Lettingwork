import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../hooks/usePWAInstall';

interface OfflineIndicatorProps {
  t: Record<string, string>;
}

export function OfflineIndicator({ t }: OfflineIndicatorProps) {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-5 left-5 z-50 flex items-center gap-2 rounded-lg bg-amber-500/95 border border-amber-300/40 px-3.5 py-2 text-xs font-semibold text-slate-950 shadow-lg backdrop-blur-sm"
    >
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>{t.pwa_offline}</span>
    </div>
  );
}
