import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { X } from 'lucide-react';

interface QrModalProps {
  url: string | null;
  onClose: () => void;
  t: Record<string, string>;
}

export function QrModal({ url, onClose, t }: QrModalProps) {
  const [dataUrl, setDataUrl] = useState<string>('');

  useEffect(() => {
    if (!url) {
      setDataUrl('');
      return;
    }
    let active = true;
    QRCode.toDataURL(url, {
      width: 220,
      margin: 2,
      color: { dark: '#0a0e17', light: '#ffffff' },
    })
      .then((res) => {
        if (active) setDataUrl(res);
      })
      .catch(() => {
        if (active) setDataUrl('');
      });
    return () => {
      active = false;
    };
  }, [url]);

  if (!url) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-2xl bg-[#141c2c] border border-white/10 p-7 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t.btn_close}
          className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <h3 className="text-lg font-bold text-white">{t.qr_title}</h3>
        <p className="text-sm text-slate-400 mt-1">{t.qr_desc}</p>

        <div className="my-5 inline-flex items-center justify-center rounded-xl bg-white p-3">
          {dataUrl ? (
            <img
              src={dataUrl}
              alt="QR Code"
              width={200}
              height={200}
              className="block rounded"
            />
          ) : (
            <div className="w-[200px] h-[200px] flex items-center justify-center text-slate-500 text-xs">
              QR...
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full py-2.5 px-4 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 text-sm font-semibold text-white transition-colors cursor-pointer"
        >
          {t.btn_close}
        </button>
      </div>
    </div>
  );
}
