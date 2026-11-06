// Waveform levels calculated from a camera's preview frame. The camera does not send its own
// waveform data over XC, only a button that shows it on the camera's screen.

// JPEG brightness from RGB (JFIF weights, which undo the decoder's own conversion). The C80's
// preview appears to carry video levels unchanged, so 16 is 0% and 235 is 100%, the same scale as
// a broadcast waveform. Check against the camera's WFM display before relying on exact numbers.
const percent = (y) => Math.max(0, Math.round(((y - 16) / 219) * 100));

// data is BGRA or RGBA: red and blue swap, which barely moves the result, so pass the real order.
export function lumaStats(data, width, height, { bgra = true } = {}) {
  const hist = new Uint32Array(256);
  const r = bgra ? 2 : 0, b = bgra ? 0 : 2;
  let sum = 0, n = 0;
  for (let row = 0; row < height; row += 2) {
    for (let col = 0; col < width; col += 2) {
      const i = (row * width + col) * 4;
      const y = Math.round(0.299 * data[i + r] + 0.587 * data[i + 1] + 0.114 * data[i + b]);
      hist[y]++;
      sum += y;
      n++;
    }
  }
  if (!n) return null;
  // Percentiles, so one hot pixel or a compression speck does not set the reading.
  const at = (share) => {
    let seen = 0;
    for (let y = 0; y < 256; y++) { seen += hist[y]; if (seen >= share * n) return y; }
    return 255;
  };
  return { peak: percent(at(0.995)), avg: percent(sum / n), low: percent(at(0.005)) };
}
