/* ==========================================================
   Analog Signal Spectrum Analyzer — app.js
   All signal math, FFT, charts, UI logic
   ========================================================== */

'use strict';

/* ── Register Chart.js Zoom Plugin ── */
if (window.ChartZoom) Chart.register(window.ChartZoom);

/* ── Constants ── */
const NUM_SAMPLES   = 4096;  // must be power-of-2 for FFT
const TIME_POINTS   = 1024;  // points rendered in time chart
const CYCLES_SHOWN  = 5;     // how many signal cycles to display

/* ── DOM Refs ── */
const $ = id => document.getElementById(id);

const elLoader        = $('loader');
const elThemeBtn      = $('theme-toggle');
const elMobileMenuBtn = $('mobile-menu-btn');
const elMainNav       = $('main-nav');
const elHeader        = $('site-header');

// Sliders & selects
const slSignalType  = $('signal-type');
const slFreq        = $('frequency-slider');
const slAmp         = $('amplitude-slider');
const slPhase       = $('phase-slider');
const slFs          = $('sampling-freq');

// Value badges
const bdFreq  = $('freq-val');
const bdAmp   = $('amp-val');
const bdPhase = $('phase-val');
const bdFs    = $('fs-val');

// Buttons
const btnGenerate = $('generate-btn');
const btnReset    = $('reset-btn');

// Info card
const iType   = $('info-type');
const iFreq   = $('info-freq');
const iAmp    = $('info-amp');
const iPhase  = $('info-phase');
const iFs     = $('info-fs');
const iPeak   = $('info-peak');
const iPeriod = $('info-period');
const iOmega  = $('info-omega');

/* ── State ── */
let currentParams = {
  type:  'sine',
  freq:  440,
  amp:   1.0,
  phase: 0,
  fs:    44100,
};
let timeChartInstance = null;
let fftChartInstance  = null;
let heroAnimFrame     = null;

/* ==========================================================
   LOADER
   ========================================================== */
window.addEventListener('load', () => {
  setTimeout(() => {
    elLoader.classList.add('fade-out');
    setTimeout(() => elLoader.style.display = 'none', 700);
  }, 1200);

  initHeroCanvas();
  initCharts();
  generateAndRender();
  initScrollSpy();
  initNavHighlight();
});

/* ==========================================================
   THEME TOGGLE
   ========================================================== */
elThemeBtn.addEventListener('click', () => {
  const html  = document.documentElement;
  const theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', theme);
  updateChartTheme();
});

function getThemeColors() {
  const style   = getComputedStyle(document.documentElement);
  const isDark  = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    grid:   isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)',
    tick:   isDark ? '#8899b4' : '#64748b',
    text:   isDark ? '#e2e8f0' : '#1a202c',
    bg:     isDark ? '#111827' : '#ffffff',
  };
}

/* ==========================================================
   MOBILE NAV
   ========================================================== */
elMobileMenuBtn.addEventListener('click', () => {
  elMainNav.classList.toggle('open');
});
elMainNav.addEventListener('click', e => {
  if (e.target.classList.contains('nav-link')) elMainNav.classList.remove('open');
});

/* ==========================================================
   SCROLL HEADER SHADOW + SPY
   ========================================================== */
window.addEventListener('scroll', () => {
  elHeader.classList.toggle('scrolled', window.scrollY > 20);
}, { passive: true });

function initScrollSpy() {
  const sections = document.querySelectorAll('section[id]');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (en.isIntersecting) {
        document.querySelectorAll('.nav-link').forEach(l => {
          l.classList.toggle('active', l.dataset.section === en.target.id);
        });
      }
    });
  }, { threshold: 0.35 });
  sections.forEach(s => observer.observe(s));
}

function initNavHighlight() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });
}

/* ==========================================================
   SLIDER → BADGE SYNC
   ========================================================== */
slFreq.addEventListener('input', () => {
  bdFreq.textContent = formatHz(+slFreq.value);
  currentParams.freq = +slFreq.value;
  debouncedGenerate();
});
slAmp.addEventListener('input', () => {
  bdAmp.textContent = (+slAmp.value).toFixed(1) + ' V';
  currentParams.amp = +slAmp.value;
  debouncedGenerate();
});
slPhase.addEventListener('input', () => {
  bdPhase.textContent = slPhase.value + '°';
  currentParams.phase = +slPhase.value;
  debouncedGenerate();
});
slFs.addEventListener('input', () => {
  bdFs.textContent = formatHz(+slFs.value);
  currentParams.fs = +slFs.value;
  debouncedGenerate();
});
slSignalType.addEventListener('change', () => {
  currentParams.type = slSignalType.value;
  debouncedGenerate();
});

btnGenerate.addEventListener('click', generateAndRender);
btnReset.addEventListener('click', resetAll);

/* ==========================================================
   DEBOUNCE
   ========================================================== */
let debTimer = null;
function debouncedGenerate() {
  clearTimeout(debTimer);
  debTimer = setTimeout(generateAndRender, 60);
}

/* ==========================================================
   SIGNAL GENERATION
   ========================================================== */
function generateSignal(params, N) {
  const { type, freq, amp, phase, fs } = params;
  const phRad = (phase * Math.PI) / 180;
  const data  = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const t = n / fs;
    const arg = 2 * Math.PI * freq * t + phRad;
    data[n] = type === 'cosine' ? amp * Math.cos(arg) : amp * Math.sin(arg);
  }
  return data;
}

function getTimeSeries(params) {
  const { freq, fs } = params;
  const periodSamples = Math.round(fs / freq);
  const totalSamples  = Math.min(periodSamples * CYCLES_SHOWN, TIME_POINTS * 4);
  const step          = Math.max(1, Math.floor(totalSamples / TIME_POINTS));
  const samples       = generateSignal(params, totalSamples + step);

  const x = [], y = [];
  for (let i = 0; i < totalSamples; i += step) {
    x.push(+(i / fs * 1000).toFixed(5)); // ms
    y.push(samples[i]);
  }
  return { x, y };
}

/* ==========================================================
   FFT — Cooley-Tukey Radix-2 DIT
   ========================================================== */
function fft(re, im) {
  const N = re.length;
  if (N <= 1) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  // Butterfly operations
  for (let len = 2; len <= N; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let uRe = 1, uIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const p  = i + k, q = i + k + len / 2;
        const tRe = uRe * re[q] - uIm * im[q];
        const tIm = uRe * im[q] + uIm * re[q];
        re[q] = re[p] - tRe; im[q] = im[p] - tIm;
        re[p] += tRe;        im[p] += tIm;
        const tmp = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = tmp;
      }
    }
  }
}

function computeFFT(signal, fs) {
  const N   = signal.length;
  const re  = Array.from(signal);
  const im  = new Array(N).fill(0);
  fft(re, im);

  // One-sided spectrum
  const half = N / 2;
  const freq  = [], mag = [];
  let peakMag = 0, peakFreq = 0;

  for (let k = 0; k < half; k++) {
    const f = (k * fs) / N;
    const m = Math.sqrt(re[k] ** 2 + im[k] ** 2) / N * 2;
    freq.push(+f.toFixed(2));
    mag.push(+m.toFixed(6));
    if (m > peakMag) { peakMag = m; peakFreq = f; }
  }
  return { freq, mag, peakFreq, peakMag };
}

/* ==========================================================
   MAIN GENERATE & RENDER
   ========================================================== */
function generateAndRender() {
  const p = { ...currentParams };

  // Validate sampling rate (Nyquist check)
  if (p.fs < 2 * p.freq) {
    showNyquistWarning(p);
  }

  // Time domain
  const { x: tX, y: tY } = getTimeSeries(p);
  updateTimeChart(tX, tY);

  // Frequency domain
  const signal = generateSignal(p, NUM_SAMPLES);
  const { freq, mag, peakFreq, peakMag } = computeFFT(signal, p.fs);

  // Only show 0…min(fs/2, freq*8) for clarity
  const maxDisplay = Math.min(p.fs / 2, p.freq * 12 + 500);
  const cutIdx = freq.findIndex(f => f > maxDisplay) + 1;
  const fDisplay = cutIdx > 1 ? freq.slice(0, cutIdx) : freq;
  const mDisplay = cutIdx > 1 ? mag.slice(0, cutIdx)  : mag;

  updateFFTChart(fDisplay, mDisplay, peakFreq);
  updateInfoCard(p, peakFreq);
}

/* ==========================================================
   CHART INITIALISATION
   ========================================================== */
function chartDefaults() {
  const c = getThemeColors();
  return {
    responsive:          true,
    maintainAspectRatio: false,
    animation:           { duration: 400, easing: 'easeInOutQuart' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#111827',
        borderColor:     'rgba(0,212,255,0.3)',
        borderWidth:     1,
        titleColor:      '#e2e8f0',
        bodyColor:       '#8899b4',
        padding:         10,
        cornerRadius:    8,
      },
      zoom: {
        zoom:  { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' },
        pan:   { enabled: true, mode: 'x' },
      },
    },
    scales: {
      x: {
        grid:  { color: c.grid, drawBorder: false },
        ticks: { color: c.tick, maxTicksLimit: 10, font: { family: "'JetBrains Mono', monospace", size: 10 } },
      },
      y: {
        grid:  { color: c.grid, drawBorder: false },
        ticks: { color: c.tick, font: { family: "'JetBrains Mono', monospace", size: 10 } },
      },
    },
  };
}

function initCharts() {
  const c = getThemeColors();

  /* Time Domain Chart */
  const ctxTime = $('time-chart').getContext('2d');
  const timeGrad = ctxTime.createLinearGradient(0, 0, 0, 380);
  timeGrad.addColorStop(0,   'rgba(0,212,255,0.25)');
  timeGrad.addColorStop(0.5, 'rgba(0,128,255,0.08)');
  timeGrad.addColorStop(1,   'rgba(0,128,255,0)');

  timeChartInstance = new Chart(ctxTime, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label:           'Amplitude (V)',
        data:            [],
        borderColor:     '#00d4ff',
        borderWidth:     2,
        backgroundColor: timeGrad,
        fill:            true,
        tension:         0.3,
        pointRadius:     0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: '#00d4ff',
      }],
    },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          ...chartDefaults().plugins.tooltip,
          callbacks: {
            title: ctx => `t = ${ctx[0].label} ms`,
            label: ctx => `A = ${(+ctx.raw).toFixed(4)} V`,
          },
        },
      },
      scales: {
        x: {
          ...chartDefaults().scales.x,
          title: { display: true, text: 'Time (ms)', color: c.tick, font: { size: 11 } },
        },
        y: {
          ...chartDefaults().scales.y,
          title: { display: true, text: 'Amplitude (V)', color: c.tick, font: { size: 11 } },
        },
      },
    },
  });

  /* FFT Spectrum Chart */
  const ctxFft = $('fft-chart').getContext('2d');
  const fftGrad = ctxFft.createLinearGradient(0, 0, 0, 380);
  fftGrad.addColorStop(0,   'rgba(139,92,246,0.4)');
  fftGrad.addColorStop(0.7, 'rgba(0,128,255,0.15)');
  fftGrad.addColorStop(1,   'rgba(0,128,255,0)');

  fftChartInstance = new Chart(ctxFft, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label:           'Magnitude',
        data:            [],
        backgroundColor: fftGrad,
        borderColor:     '#8b5cf6',
        borderWidth:     1,
        borderRadius:    2,
        hoverBackgroundColor: 'rgba(0,212,255,0.5)',
      }],
    },
    options: {
      ...chartDefaults(),
      plugins: {
        ...chartDefaults().plugins,
        tooltip: {
          ...chartDefaults().plugins.tooltip,
          callbacks: {
            title: ctx => `f = ${ctx[0].label} Hz`,
            label: ctx => `|X(f)| = ${(+ctx.raw).toFixed(5)}`,
          },
        },
      },
      scales: {
        x: {
          ...chartDefaults().scales.x,
          title: { display: true, text: 'Frequency (Hz)', color: c.tick, font: { size: 11 } },
          ticks: {
            ...chartDefaults().scales.x.ticks,
            maxTicksLimit: 14,
            callback: v => {
              const label = fftChartInstance?.data.labels[v];
              return label !== undefined ? formatHz(+label) : '';
            },
          },
        },
        y: {
          ...chartDefaults().scales.y,
          title: { display: true, text: 'Magnitude', color: c.tick, font: { size: 11 } },
          beginAtZero: true,
        },
      },
    },
  });
}

/* ==========================================================
   CHART UPDATES
   ========================================================== */
function updateTimeChart(x, y) {
  if (!timeChartInstance) return;
  timeChartInstance.data.labels   = x;
  timeChartInstance.data.datasets[0].data = y;
  timeChartInstance.update('active');
}

function updateFFTChart(freq, mag, peakFreq) {
  if (!fftChartInstance) return;
  fftChartInstance.data.labels   = freq;
  fftChartInstance.data.datasets[0].data = mag;

  // Color peak bar distinctly
  const colors = mag.map((_m, i) => {
    const f = freq[i];
    return Math.abs(f - peakFreq) < 2 ? 'rgba(0,212,255,0.85)' : 'rgba(139,92,246,0.35)';
  });
  fftChartInstance.data.datasets[0].backgroundColor = colors;
  fftChartInstance.data.datasets[0].borderColor      = colors.map(c =>
    c.includes('212') ? '#00d4ff' : '#8b5cf6'
  );
  fftChartInstance.update('active');
}

function updateChartTheme() {
  if (!timeChartInstance || !fftChartInstance) return;
  const opts = chartDefaults();
  [timeChartInstance, fftChartInstance].forEach(ch => {
    ch.options.scales.x.grid.color  = opts.scales.x.grid.color;
    ch.options.scales.y.grid.color  = opts.scales.y.grid.color;
    ch.options.scales.x.ticks.color = opts.scales.x.ticks.color;
    ch.options.scales.y.ticks.color = opts.scales.y.ticks.color;
    ch.update();
  });
}

/* ==========================================================
   INFO CARD UPDATE
   ========================================================== */
function updateInfoCard(p, peakFreq) {
  const T     = 1 / p.freq;
  const omega = 2 * Math.PI * p.freq;

  iType.textContent   = p.type === 'sine' ? 'Sine Wave' : 'Cosine Wave';
  iFreq.textContent   = formatHz(p.freq);
  iAmp.textContent    = p.amp.toFixed(2) + ' V';
  iPhase.textContent  = p.phase + '°';
  iFs.textContent     = formatHz(p.fs);
  iPeak.textContent   = formatHz(peakFreq);
  iPeriod.textContent = formatTime(T);
  iOmega.textContent  = omega.toFixed(2) + ' rad/s';

  // Animate values
  [iFreq, iAmp, iPhase, iFs, iPeak, iPeriod, iOmega].forEach(el => {
    el.style.transition = 'none';
    el.style.color = 'var(--c-cyan)';
    requestAnimationFrame(() => {
      el.style.transition = 'color 0.6s';
      el.style.color = '';
    });
  });
}

/* ==========================================================
   NYQUIST WARNING
   ========================================================== */
function showNyquistWarning(p) {
  const div = document.createElement('div');
  div.className = 'nyquist-warn';
  div.textContent = `⚠ Nyquist violated! fs (${formatHz(p.fs)}) < 2f (${formatHz(2 * p.freq)}). Aliasing may occur.`;
  div.style.cssText = `
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4);
    color: #fca5a5; padding: 10px 20px; border-radius: 10px;
    font-size: 0.8125rem; font-family: var(--font-mono, monospace);
    z-index: 9000; white-space: nowrap; backdrop-filter: blur(8px);
    animation: fadeInUp 0.3s ease both;
  `;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3500);
}

/* ==========================================================
   RESET
   ========================================================== */
function resetAll() {
  currentParams = { type: 'sine', freq: 440, amp: 1.0, phase: 0, fs: 44100 };

  slSignalType.value = 'sine';
  slFreq.value       = 440;   bdFreq.textContent  = '440 Hz';
  slAmp.value        = 1.0;   bdAmp.textContent   = '1.0 V';
  slPhase.value      = 0;     bdPhase.textContent = '0°';
  slFs.value         = 44100; bdFs.textContent    = '44100 Hz';

  // Reset zoom
  timeChartInstance?.resetZoom();
  fftChartInstance?.resetZoom();

  // Clear preset highlights
  document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));

  generateAndRender();
}

/* ==========================================================
   PRESETS
   ========================================================== */
const PRESETS = {
  voice: { type: 'sine',   freq: 300,  amp: 0.8, phase: 0,  fs: 44100 },
  audio: { type: 'sine',   freq: 440,  amp: 1.0, phase: 0,  fs: 44100 },
  low:   { type: 'cosine', freq: 50,   amp: 2.0, phase: 0,  fs: 8000  },
  high:  { type: 'sine',   freq: 4000, amp: 0.5, phase: 30, fs: 96000 },
};

document.querySelectorAll('.preset-card').forEach(card => {
  card.addEventListener('click', () => {
    const key = card.dataset.preset;
    const p   = PRESETS[key];
    if (!p) return;

    currentParams = { ...p };

    slSignalType.value = p.type;
    slFreq.value       = p.freq;  bdFreq.textContent  = formatHz(p.freq);
    slAmp.value        = p.amp;   bdAmp.textContent   = p.amp.toFixed(1) + ' V';
    slPhase.value      = p.phase; bdPhase.textContent = p.phase + '°';
    slFs.value         = p.fs;    bdFs.textContent    = formatHz(p.fs);

    document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');

    // Scroll to charts
    document.querySelector('#signal-generator').scrollIntoView({ behavior: 'smooth' });

    timeChartInstance?.resetZoom();
    fftChartInstance?.resetZoom();
    generateAndRender();
  });
});

/* ==========================================================
   EXPORT — PNG
   ========================================================== */
$('export-time-png').addEventListener('click', () => exportPNG(timeChartInstance, 'time-domain'));
$('export-fft-png').addEventListener('click', ()  => exportPNG(fftChartInstance,  'fft-spectrum'));

function exportPNG(chart, name) {
  if (!chart) return;
  const a = document.createElement('a');
  a.href     = chart.toBase64Image('image/png', 1.0);
  a.download = `${name}-${Date.now()}.png`;
  a.click();
}

/* ==========================================================
   EXPORT — CSV
   ========================================================== */
$('export-time-csv').addEventListener('click', () => {
  const p     = { ...currentParams };
  const { x, y } = getTimeSeries(p);
  const rows  = ['Time (ms),Amplitude (V)', ...x.map((t, i) => `${t},${y[i]}`)];
  downloadCSV(rows.join('\n'), 'time-domain');
});

$('export-fft-csv').addEventListener('click', () => {
  if (!fftChartInstance) return;
  const labels = fftChartInstance.data.labels;
  const data   = fftChartInstance.data.datasets[0].data;
  const rows   = ['Frequency (Hz),Magnitude', ...labels.map((f, i) => `${f},${data[i]}`)];
  downloadCSV(rows.join('\n'), 'fft-spectrum');
});

function downloadCSV(content, name) {
  const blob = new Blob([content], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${name}-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ==========================================================
   HERO CANVAS ANIMATION — Live waveform
   ========================================================== */
function initHeroCanvas() {
  const canvas = $('hero-wave-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = canvas.offsetWidth  * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }
  resize();
  window.addEventListener('resize', resize);

  let t = 0;
  function draw() {
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    ctx.clearRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    for (let x = 0; x < W; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // Centre axis
    ctx.strokeStyle = 'rgba(0,212,255,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    // Wave 1 — Cyan sine
    const grad1 = ctx.createLinearGradient(0, 0, W, 0);
    grad1.addColorStop(0,   'rgba(0,212,255,0)');
    grad1.addColorStop(0.3, 'rgba(0,212,255,0.9)');
    grad1.addColorStop(0.7, 'rgba(0,128,255,0.9)');
    grad1.addColorStop(1,   'rgba(0,128,255,0)');

    ctx.beginPath();
    ctx.strokeStyle = grad1;
    ctx.lineWidth   = 2.5;
    for (let x = 0; x < W; x++) {
      const y = H / 2 + Math.sin((x / W) * Math.PI * 6 + t) * (H * 0.3);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Wave 2 — Purple cosine (dimmer)
    const grad2 = ctx.createLinearGradient(0, 0, W, 0);
    grad2.addColorStop(0,   'rgba(139,92,246,0)');
    grad2.addColorStop(0.5, 'rgba(139,92,246,0.45)');
    grad2.addColorStop(1,   'rgba(139,92,246,0)');

    ctx.beginPath();
    ctx.strokeStyle = grad2;
    ctx.lineWidth   = 1.5;
    for (let x = 0; x < W; x++) {
      const y = H / 2 + Math.cos((x / W) * Math.PI * 4 + t * 1.3) * (H * 0.2);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Wave 3 — spectrum bars (static look, animated height)
    const barCount = 32;
    const barW     = W / barCount;
    for (let i = 0; i < barCount; i++) {
      const bh  = (Math.sin(i * 0.7 + t * 0.8) * 0.5 + 0.5) * (H * 0.35) + 5;
      const bx  = i * barW + barW * 0.15;
      const alpha = 0.12 + (i === 10 || i === 11 ? 0.3 : 0);
      ctx.fillStyle = `rgba(0,212,255,${alpha})`;
      ctx.fillRect(bx, H - bh - 8, barW * 0.7, bh);
    }

    t += 0.025;
    heroAnimFrame = requestAnimationFrame(draw);
  }
  draw();
}

/* ==========================================================
   TOOLTIPS — data-tip attributes
   ========================================================== */
const tooltip = $('tooltip');
document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', e => {
    tooltip.textContent = el.dataset.tip;
    tooltip.classList.add('visible');
    positionTooltip(e);
  });
  el.addEventListener('mousemove', positionTooltip);
  el.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
});
function positionTooltip(e) {
  const x = Math.min(e.clientX + 12, window.innerWidth  - 280);
  const y = Math.min(e.clientY + 12, window.innerHeight - 80);
  tooltip.style.left = x + 'px';
  tooltip.style.top  = y + 'px';
}

/* ==========================================================
   HELPERS
   ========================================================== */
function formatHz(hz) {
  if (hz >= 1000) return (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 2) + ' kHz';
  return hz.toFixed(0) + ' Hz';
}

function formatTime(t) {
  if (t < 1e-3)  return (t * 1e6).toFixed(2) + ' µs';
  if (t < 1)     return (t * 1e3).toFixed(4) + ' ms';
  return t.toFixed(4) + ' s';
}

