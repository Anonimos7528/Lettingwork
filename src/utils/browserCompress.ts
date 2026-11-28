export interface BrowserCompressionResult {
  file: File;
  compressed: boolean;
  originalBytes: number;
  compressedBytes: number;
  method: 'image' | 'pdf' | 'zip' | 'none';
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const DOC_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.json',
  '.md',
  '.xml',
  '.svg',
  '.html',
  '.htm',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.log',
  '.sql',
  '.yaml',
  '.yml',
]);

const MAX_IN_MEMORY_DOC_BYTES = 120 * 1024 * 1024; // 120 MB RAM safety cap for browser zip/pdf
const MIN_SAVINGS_RATIO = 0.96; // Require at least 4% size reduction

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
}

export function replaceExtension(filename: string, nextExt: string): string {
  const cleanExt = nextExt.startsWith('.') ? nextExt : `.${nextExt}`;
  const idx = filename.lastIndexOf('.');
  if (idx <= 0) return `${filename}${cleanExt}`;
  return `${filename.slice(0, idx)}${cleanExt}`;
}

export function isCompressibleImage(file: File): boolean {
  const mime = (file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  if (mime === 'image/gif' || mime === 'image/svg+xml' || ext === '.gif' || ext === '.svg') {
    return false;
  }
  if (
    mime === 'image/jpeg' ||
    mime === 'image/png' ||
    mime === 'image/webp' ||
    mime === 'image/bmp'
  ) {
    return true;
  }
  return IMAGE_EXTENSIONS.has(ext);
}

export function isCompressibleDocument(file: File): boolean {
  if (file.size <= 0 || file.size > MAX_IN_MEMORY_DOC_BYTES) return false;
  const mime = (file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  if (
    mime === 'application/pdf' ||
    mime === 'image/svg+xml' ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.includes('wordprocessingml') ||
    mime.includes('spreadsheetml') ||
    mime.includes('presentationml') ||
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/rtf'
  ) {
    return true;
  }
  return DOC_EXTENSIONS.has(ext);
}

export function isFileCompressible(file: File): boolean {
  return isCompressibleImage(file) || isCompressibleDocument(file);
}

async function decodeImageDimensions(
  file: File
): Promise<{ width: number; height: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(),
    };
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not decode image'));
      el.src = objectUrl;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mime, quality);
  });
}

async function compressImageInBrowser(file: File): Promise<BrowserCompressionResult> {
  const originalBytes = file.size;
  try {
    const decoded = await decodeImageDimensions(file);
    try {
      if (!decoded.width || !decoded.height) {
        return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
      }

      const maxEdge = 2560;
      const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
      const targetWidth = Math.max(1, Math.round(decoded.width * scale));
      const targetHeight = Math.max(1, Math.round(decoded.height * scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      decoded.draw(ctx, targetWidth, targetHeight);

      const ext = getExtension(file.name);
      const isJpeg = (file.type || '').toLowerCase() === 'image/jpeg' || ext === '.jpg' || ext === '.jpeg';

      let chosenBlob: Blob | null = null;
      let chosenMime = isJpeg ? 'image/jpeg' : 'image/webp';
      let chosenExt = isJpeg ? '.jpg' : '.webp';

      if (isJpeg) {
        chosenBlob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
      } else {
        chosenBlob = await canvasToBlob(canvas, 'image/webp', 0.84);
        if (!chosenBlob || chosenBlob.type !== 'image/webp') {
          chosenMime = 'image/jpeg';
          chosenExt = '.jpg';
          chosenBlob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
        }
      }

      if (!chosenBlob || chosenBlob.size >= originalBytes * MIN_SAVINGS_RATIO) {
        return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
      }

      const nextName = replaceExtension(file.name, chosenExt);
      const compressedFile = new File([chosenBlob], nextName, {
        type: chosenMime,
        lastModified: file.lastModified,
      });

      return {
        file: compressedFile,
        compressed: true,
        originalBytes,
        compressedBytes: compressedFile.size,
        method: 'image',
      };
    } finally {
      decoded.cleanup();
    }
  } catch {
    return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
  }
}

async function compressDocumentInBrowser(file: File): Promise<BrowserCompressionResult> {
  const originalBytes = file.size;
  if (originalBytes <= 0 || originalBytes > MAX_IN_MEMORY_DOC_BYTES) {
    return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
  }

  try {
    const rawBuffer = await file.arrayBuffer();
    const rawUint8 = new Uint8Array(rawBuffer);
    const ext = getExtension(file.name);
    const isPdf = (file.type || '').toLowerCase() === 'application/pdf' || ext === '.pdf';

    if (isPdf) {
      try {
        const { PDFDocument } = await import('pdf-lib');
        const pdfDoc = await PDFDocument.load(rawUint8, {
          ignoreEncryption: true,
          updateMetadata: false,
        });
        const optimizedBytes = await pdfDoc.save({ useObjectStreams: true });
        if (optimizedBytes.byteLength < originalBytes * MIN_SAVINGS_RATIO) {
          const optimizedPdf = new File([new Uint8Array(optimizedBytes)], file.name, {
            type: 'application/pdf',
            lastModified: file.lastModified,
          });
          return {
            file: optimizedPdf,
            compressed: true,
            originalBytes,
            compressedBytes: optimizedPdf.size,
            method: 'pdf',
          };
        }
      } catch {
        // Fall through to ZIP check if pdf-lib could not parse encrypted/custom PDF
      }
    }

    const { zipSync } = await import('fflate');
    const zipped = zipSync({ [file.name]: rawUint8 }, { level: 9 });
    if (zipped.byteLength < originalBytes * MIN_SAVINGS_RATIO) {
      const zipName = replaceExtension(file.name, '.zip');
      const zipFile = new File([new Uint8Array(zipped)], zipName, {
        type: 'application/zip',
        lastModified: file.lastModified,
      });
      return {
        file: zipFile,
        compressed: true,
        originalBytes,
        compressedBytes: zipFile.size,
        method: 'zip',
      };
    }

    return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
  } catch {
    return { file, compressed: false, originalBytes, compressedBytes: originalBytes, method: 'none' };
  }
}

export async function compressFileInBrowser(file: File): Promise<BrowserCompressionResult> {
  if (isCompressibleImage(file)) {
    return compressImageInBrowser(file);
  }
  if (isCompressibleDocument(file)) {
    return compressDocumentInBrowser(file);
  }
  return {
    file,
    compressed: false,
    originalBytes: file.size,
    compressedBytes: file.size,
    method: 'none',
  };
}
