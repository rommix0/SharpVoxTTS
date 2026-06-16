// Grid spectrogram video export for the MIDI converter: per-channel tiles
// are precomputed from the mixed per-channel PCM, then recorded in realtime
// through canvas.captureStream plus MediaRecorder with the mix as the
// audio track. Spectrogram math matches the AnalyserNode-based main export.
(function (global) {
  'use strict';

  const FFT_SIZE = 2048;
  const MIN_DB = -90;
  const MAX_DB = -20;
  const SMOOTHING = 0.2;
  const F_MIN = 40;
  const F_MAX = 10000;
  const BG_COLOR = '#050510';
  const FPS = 30;
  const WIDTH = 1280;
  const HEIGHT = 720;

  // Iterative radix-2 complex FFT, in-place over re/im arrays.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // Blackman window, matching the AnalyserNode spec.
  function blackmanWindow(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = (2 * Math.PI * i) / (n - 1);
      w[i] = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
    }
    return w;
  }

  // Same blue palette as the main video export.
  function buildColorLUT() {
    const blueStops = [[0, 2, 20], [0, 20, 80], [0, 80, 200], [0, 150, 255], [180, 240, 255]];
    const lut = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = Math.pow(i / 255, 0.8);
      const f = t * (blueStops.length - 1);
      const ii = Math.min(blueStops.length - 2, Math.floor(f));
      const fr = f - ii;
      const a = blueStops[ii], b = blueStops[ii + 1];
      lut[i * 3] = a[0] + (b[0] - a[0]) * fr;
      lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * fr;
      lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * fr;
    }
    return lut;
  }

  // Log-frequency row lookup: tile row -> fractional FFT bin, 40Hz..10kHz.
  function buildYToBin(tileH, sampleRate) {
    const lnMin = Math.log(F_MIN);
    const lnRange = Math.log(F_MAX) - lnMin;
    const bins = FFT_SIZE / 2;
    const map = new Float32Array(tileH);
    for (let y = 0; y < tileH; y++) {
      const t = 1 - y / tileH;
      const f = Math.exp(lnMin + lnRange * t);
      map[y] = Math.min(bins - 1.001, (f * FFT_SIZE) / sampleRate);
    }
    return map;
  }

  // Render one channel's full spectrogram tile as RGBA. Column x covers time
  // (x / tileW) * durationMs, analysing the most recent FFT_SIZE samples like
  // an AnalyserNode. Yields periodically so the page stays responsive.
  async function renderSpectrogramTile(samples, sampleRate, durationMs, tileW, tileH, lut) {
    const window = blackmanWindow(FFT_SIZE);
    const yToBin = buildYToBin(tileH, sampleRate);
    const re = new Float32Array(FFT_SIZE);
    const im = new Float32Array(FFT_SIZE);
    const bins = FFT_SIZE / 2;
    const smoothed = new Float32Array(bins);
    const rgba = new Uint8ClampedArray(tileW * tileH * 4);

    for (let x = 0; x < tileW; x++) {
      const tMs = ((x + 0.5) / tileW) * durationMs;
      const end = Math.min(samples.length, Math.round((tMs / 1000) * sampleRate));
      const startIdx = end - FFT_SIZE;
      for (let i = 0; i < FFT_SIZE; i++) {
        const si = startIdx + i;
        re[i] = (si >= 0 && si < samples.length ? samples[si] / 32768 : 0) * window[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < bins; k++) {
        const mag = Math.hypot(re[k], im[k]) / FFT_SIZE;
        smoothed[k] = SMOOTHING * smoothed[k] + (1 - SMOOTHING) * mag;
      }
      for (let y = 0; y < tileH; y++) {
        const bf = yToBin[y];
        const i = bf | 0;
        const frac = bf - i;
        const m = smoothed[i] * (1 - frac) + smoothed[i + 1] * frac;
        const dB = m > 0 ? 20 * Math.log10(m) : MIN_DB;
        const norm = Math.max(0, Math.min(1, (dB - MIN_DB) / (MAX_DB - MIN_DB)));
        const ci = (norm * 255) | 0;
        const off = (y * tileW + x) * 4;
        rgba[off] = lut[ci * 3];
        rgba[off + 1] = lut[ci * 3 + 1];
        rgba[off + 2] = lut[ci * 3 + 2];
        rgba[off + 3] = 255;
      }
      if ((x & 63) === 63) await global.yieldToEventLoop();
    }
    return rgba;
  }

  // Largest index with times[i] <= target, or -1.
  function bisect(times, target) {
    let lo = 0, hi = times.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= target) { res = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return res;
  }

  function gridFor(n) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.max(1, Math.ceil(n / cols));
    return { cols, rows };
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // result is ui._midiResult: { samples, sampleRate, chAudio, chPhonemes,
  // durationMs }. status is a text callback. Resolves after the download
  // anchor has been clicked.
  async function exportVideo(result, status) {
    const { samples, sampleRate, chAudio, chPhonemes, durationMs } = result;
    const channels = [...chAudio.keys()].sort((a, b) => a - b);
    const n = channels.length;
    if (!n) throw new Error('no channel audio to export');

    const { cols, rows } = gridFor(n);
    const cellW = Math.floor(WIDTH / cols);
    const cellH = Math.floor(HEIGHT / rows);
    const lut = buildColorLUT();

    const tiles = new Map();
    for (let i = 0; i < n; i++) {
      status(`computing spectrogram ${i + 1}/${n}...`, ((i + 1) / n) * 0.3);
      await global.yieldToEventLoop();
      const ch = channels[i];
      const rgba = await renderSpectrogramTile(chAudio.get(ch), sampleRate, durationMs, cellW, cellH, lut);
      const tile = makeCanvas(cellW, cellH);
      tile.getContext('2d').putImageData(new ImageData(rgba, cellW, cellH), 0, 0);
      tiles.set(ch, tile);
    }

    const phonemeTimes = new Map();
    for (const ch of channels) {
      phonemeTimes.set(ch, (chPhonemes.get(ch) || []).map(p => p.timeMs));
    }

    const fontPx = Math.max(18, Math.round(cellH * 0.16));
    const phonemeFont = `bold ${fontPx}px ui-monospace, monospace`;
    const labelFont = `${Math.max(11, Math.round(cellH * 0.06))}px ui-monospace, monospace`;

    // Shadow blur is expensive per fillText, so cache each code's glyph once.
    const glyphPad = 16;
    const glyphCache = new Map();
    function phonemeGlyph(code) {
      let g = glyphCache.get(code);
      if (!g) {
        g = makeCanvas(fontPx * code.length + glyphPad * 2, fontPx + glyphPad * 2);
        const gctx = g.getContext('2d');
        gctx.font = phonemeFont;
        gctx.textBaseline = 'top';
        gctx.shadowColor = 'rgba(0,0,0,0.8)';
        gctx.shadowBlur = 12;
        gctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
        gctx.fillText(code, glyphPad, glyphPad);
        glyphCache.set(code, g);
      }
      return g;
    }

    // Labels, borders, and watermark never change; render them once.
    const overlay = makeCanvas(WIDTH, HEIGHT);
    {
      const octx = overlay.getContext('2d');
      for (let i = 0; i < n; i++) {
        const cx = (i % cols) * cellW;
        const cy = Math.floor(i / cols) * cellH;
        octx.font = labelFont;
        octx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        octx.fillText(`ch ${channels[i]}`, cx + 6, cy + cellH - 7);
        octx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        octx.lineWidth = 1;
        octx.strokeRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1);
      }
      octx.font = '20px ui-monospace, monospace';
      octx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      octx.textAlign = 'right';
      octx.fillText('bytesizedfox.dev/sharpvox/', WIDTH - 40, 40);
    }

    const canvas = makeCanvas(WIDTH, HEIGHT);
    Object.assign(canvas.style, {
      position: 'fixed', bottom: '1rem', right: '1rem',
      width: '320px', height: 'auto',
      border: '1px solid #333', borderRadius: '3px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      background: BG_COLOR,
      zIndex: 9999,
    });
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const actx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate });
    const dest = actx.createMediaStreamDestination();

    const floatData = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) floatData[i] = samples[i] / 32768.0;
    const audioBuffer = actx.createBuffer(1, floatData.length, sampleRate);
    audioBuffer.copyToChannel(floatData, 0);
    const source = actx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);

    const stream = new MediaStream([
      ...canvas.captureStream(FPS).getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);

    const mimeType = ['video/mp4', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 128_000,
    });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    status('recording video...', 0.3);

    await new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sharpvox_midi_${Date.now()}.${ext}`;
        a.click();
        canvas.remove();
        actx.close();
        resolve();
      };
      recorder.onerror = e => {
        canvas.remove();
        actx.close();
        reject(e.error || new Error('MediaRecorder error'));
      };

      recorder.start();
      source.start();
      const t0 = performance.now();
      const durSec = durationMs / 1000;

      const renderLoop = () => {
        const elapsed = (performance.now() - t0) / 1000;
        const tMs = Math.min(durationMs, elapsed * 1000);
        const fillX = Math.min(cellW, Math.ceil((tMs / durationMs) * cellW));
        status('recording video...', 0.3 + (tMs / durationMs) * 0.7);

        ctx.fillStyle = BG_COLOR;
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        for (let i = 0; i < n; i++) {
          const ch = channels[i];
          const cx = (i % cols) * cellW;
          const cy = Math.floor(i / cols) * cellH;

          if (fillX > 0) {
            ctx.drawImage(tiles.get(ch), 0, 0, fillX, cellH, cx, cy, fillX, cellH);
          }

          const times = phonemeTimes.get(ch);
          const idx = bisect(times, tMs);
          const code = idx >= 0 ? chPhonemes.get(ch)[idx].code : '';
          if (code && code !== 'SIL') {
            ctx.drawImage(phonemeGlyph(code),
              cx + Math.round(cellW * 0.03) - glyphPad,
              cy + Math.round(cellH * 0.06) - glyphPad);
          }
        }

        ctx.drawImage(overlay, 0, 0);

        if (elapsed < durSec + 0.3) {
          requestAnimationFrame(renderLoop);
        } else {
          recorder.stop();
        }
      };
      renderLoop();
    });

    status('video export complete', 1);
  }

  global.MidiVideo = { exportVideo };

})(window);
