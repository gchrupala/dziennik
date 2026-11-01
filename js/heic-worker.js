// Podgląd zdjęć HEIC/HEIF (przeglądarki ich nie wyświetlają): dekodowanie libheif (heic-to, wersja przypięta),
// zmniejszenie i zapis jako JPEG. W osobnym wątku, bo dekodowanie trwa kilka sekund.
import { heicTo } from 'https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/csp/heic-to.js';

self.onmessage = async ({ data: { id, blob, max, quality } }) => {
  try {
    const bmp = await heicTo({ blob, type: 'bitmap' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    self.postMessage({ id, jpeg: await canvas.convertToBlob({ type: 'image/jpeg', quality }) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
