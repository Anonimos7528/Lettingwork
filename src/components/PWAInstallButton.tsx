import { useState } from 'react';
import { Download, Smartphone, Share, PlusSquare, X, Cloud } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  t: Record<string, string>;
  variant?: 'nav' | 'drawer';
}

export function PWAInstallButton({ t, variant = 'nav' }: PWAInstallButtonProps) {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuide(true);
  };

  // Show direct install prompt when Chromium beforeinstallprompt is ready, or on iOS,
  // or in the SideDrawer menu so users always have a clean way to install the app.
  if (!isInstallable && !isIOS && variant === 'nav') {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className={
          variant === 'drawer'
            ? 'w-full py-2.5 px-4 rounded-lg bg-white/[0.06] hover:bg-white/12 border border-cyan-400/30 text-xs sm:text-sm font-semibold text-cyan-200 flex items-center justify-center gap-2 transition-colors cursor-pointer'
            : 'px-3 py-2 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/35 text-xs font-semibold text-cyan-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer'
        }
      >
        {isIOS ? (
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
        ) : (
          <Download className="w-3.5 h-3.5 text-cyan-400" />
        )}
        <span>{t.pwa_install}</span>
      </button>

      {showGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="relative w-full max-w-sm rounded-xl bg-[#0b111c] border border-white/10 p-6 shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              aria-label={t.btn_close}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-cyan-500/15 border border-cyan-400/30 flex items-center justify-center shrink-0">
                <Cloud className="w-6 h-6 text-cyan-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">{t.pwa_install_title}</h3>
                <p className="text-xs text-slate-400">LettingWork App</p>
              </div>
            </div>

            {isIOS ? (
              <div className="space-y-2.5 text-xs sm:text-sm text-slate-300 leading-relaxed">
                <p className="flex items-center gap-2">
                  <Share className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>{t.pwa_install_ios_step1}</span>
                </p>
                <p className="flex items-center gap-2">
                  <PlusSquare className="w-4 h-4 text-cyan-400 shrink-0" />
                  <span>{t.pwa_install_ios_step2}</span>
                </p>
              </div>
            ) : (
              <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
                {t.pwa_install_browser_hint}
              </p>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs sm:text-sm font-bold cursor-pointer"
            >
              {t.btn_close}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
