#!/usr/bin/env node
/**
 * Compose watchable walkthrough media from a live tour capture.
 *
 *   npm run tour:record
 *   npm run tour:compose            (--short | --howto to build one)
 *
 * Reads:
 *   docs/walkthrough-assets/tour-raw/app.webm
 *   docs/walkthrough-assets/tour-raw/actions.json
 *
 * Writes:
 *   docs/walkthrough-assets/how-to-use.mp4               (1920×1080)
 *   docs/walkthrough-assets/shorts/stratosort-short.mp4  (1080×1920, whole UI over a blurred fill)
 *
 * The edit is built like a screen-recording director would cut it:
 *   - scenes, each one step of using the product, hard-cut inside and crossfaded between
 *   - a camera that pushes in on the recorded click point for the payoff, then eases back out
 *   - time-lapses over the waits (typing, analysis, the move) so nothing sits still
 *   - a step caption per scene (in the letterbox on the Short, a lower-third on the tour)
 *   - a short brand outro
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'walkthrough-assets');
const RAW_DIR = path.join(OUT_DIR, 'tour-raw');
const SHORT_DIR = path.join(OUT_DIR, 'shorts');
const VIDEO = path.join(RAW_DIR, 'app.webm');
const ACTIONS = path.join(RAW_DIR, 'actions.json');
const LOGO = path.join(ROOT, 'assets', 'stratosort-logo.png');

const FPS = 25;
// Lessons still dissolve between steps. The how-to and the short cut hard:
// a dissolve of two different screens reads as a mistake.
const SCENE_XFADE = 0.35;
const OUTRO_FADE = 0.45;
const OUTRO_READABLE = 3.2;
const OUTRO_SECONDS = OUTRO_READABLE + OUTRO_FADE + 0.5;
const BLUR_BG = 'gblur=sigma=28,eq=brightness=-0.2:saturation=0.8';
const INK = '0x0b1220';

/**
 * Scene = one step of the story, with a caption. Cut fields:
 *   id          recorded action the cut is anchored on (its `t` is the click)
 *   padBefore   real seconds to reach back before the click (typing, hover)
 *   duration    seconds of output the cut occupies
 *   speed       time-lapse factor (real seconds consumed = duration × speed)
 *   from/until  anchor the window on two actions instead (speed is derived)
 *   requires    drop this cut when the named payoff beat did not land
 *   cam         camera keyframes {t, z, focus}: t is clip-relative output seconds
 *               (negative = from the end), z the push-in on the UI, focus the point
 *               kept in frame — 'action' (the recorded click) or a normalized [x, y].
 *               Missing z/focus inherit from the previous keyframe.
 */
// Windows are measured against this capture, not a generic timing model.
// A caption may only cover footage of the screen it names. Zooms stay wide
// enough that the action (the name, the counter, the answer, the graph) is
// still readable. The in-app graph zoom is the close-up; another camera push
// on top of it slices the node off the frame.

function setupScene() {
  return {
    title: 'Add Smart Folders',
    cuts: [
      {
        // Dialog still open: Finance, its description, Add folder.
        id: 'setup-finance',
        from: { id: 'setup-add', offset: -1.55 },
        until: { id: 'setup-add', offset: -0.85 },
        duration: 1.4
      },
      {
        id: 'setup-research',
        from: { id: 'setup-research', offset: -1.5 },
        until: { id: 'setup-research', offset: -0.8 },
        duration: 1.25
      },
      {
        id: 'setup-nature',
        from: { id: 'setup-nature', offset: -1.5 },
        until: { id: 'setup-nature', offset: -0.75 },
        duration: 1.25
      }
    ]
  };
}

function discoverScene() {
  return {
    title: 'Drop in your files',
    cuts: [
      {
        id: 'discover-empty',
        padBefore: 0.25,
        duration: 1.15
      },
      {
        // Files have landed and the counter reads 0 of 6.
        id: 'discover-drop',
        padBefore: 0.15,
        duration: 1.9
      },
      {
        // The bar fills. Stop while Discover is still on screen (5 of 6).
        // The later "counted" mark is already the Organize page.
        id: 'discover-timelapse',
        from: { id: 'discover-drop', offset: 2.2 },
        until: { id: 'discover-drop', offset: 29.5 },
        duration: 2.1
      },
      {
        id: 'discover-hold',
        from: { id: 'discover-drop', offset: 31.2 },
        until: { id: 'discover-drop', offset: 33.0 },
        duration: 1.7
      }
    ]
  };
}

function reviewScene() {
  return {
    title: 'Review what the AI found',
    cuts: [
      {
        // The six cards, names and categories still in frame. No push-in.
        id: 'organize-cards',
        from: { id: 'organize-rename', offset: -4.6 },
        until: { id: 'organize-rename', offset: -3.35 },
        duration: 1.25
      },
      {
        id: 'organize-rename',
        padBefore: 0.1,
        duration: 2.5,
        speed: 1.15
      },
      {
        // The menu opens and the card now says Nature.
        id: 'organize-category',
        padBefore: 0.35,
        duration: 2.1
      }
    ]
  };
}

function moveScene() {
  return {
    title: 'Move everything in one click',
    cuts: [
      {
        // Pointer is on Move 6 files. Leave before the destination list opens.
        id: 'organize-press',
        from: { id: 'organize-move', offset: -1.25 },
        until: { id: 'organize-move', offset: -0.88 },
        duration: 1.15
      },
      {
        // The popup and the bar. Tight enough that the destination list stays out.
        id: 'organize-move',
        from: { id: 'organize-move', offset: 0.45 },
        until: { id: 'organize-move', offset: 1.65 },
        duration: 1.55,
        cam: [{ t: 0, z: 3.15, focus: [0.5, 0.23] }]
      },
      {
        // Heading and the 6-files line. Leave before search opens, and above the list.
        id: 'complete',
        from: { id: 'complete', offset: 0.5 },
        until: { id: 'complete', offset: 1.55 },
        duration: 2.3,
        cam: [{ t: 0, z: 2.55, focus: [0.5, 0.16] }]
      }
    ]
  };
}

function searchScene() {
  return {
    title: 'Search by meaning',
    cuts: [
      {
        // Query, ranked results, and the arctic preview are all on screen here.
        id: 'search',
        from: { id: 'search', offset: -2.6 },
        until: { id: 'search', offset: 1.7 },
        duration: 4.0
      }
    ]
  };
}

function chatScene() {
  return {
    title: 'Chat with your documents',
    cuts: [
      {
        id: 'chat-send',
        padBefore: 1.7,
        duration: 1.8,
        requires: 'chat'
      },
      {
        // The cited paragraph is already on screen. A push-in crops it.
        id: 'chat',
        padBefore: 2.0,
        duration: 4.0
      }
    ]
  };
}

function relateScene() {
  return {
    title: 'See how files connect',
    cuts: [
      {
        // In-app zoom has already enlarged the node. Hold through Why connected.
        id: 'relate-open',
        from: { id: 'relate', offset: -0.35 },
        until: { id: 'relate-why', offset: 1.35 },
        duration: 3.5
      }
    ]
  };
}

function atlasScene({ duration }) {
  return {
    title: 'Map your whole library',
    cuts: [
      {
        // Pointer lands on the map and wheel-zooms it.
        id: 'atlas',
        padBefore: 0.6,
        duration,
        cam: [
          { t: 0, z: 1, focus: [0.5, 0.5] },
          { t: duration, z: 1.1 }
        ]
      }
    ]
  };
}

// One edit (~55s). The Short is this same cut in 9:16; the tour is 16:9.
const HOW_TO_SCENES = [
  {
    title: 'Welcome',
    cuts: [
      { id: 'welcome-cta', padBefore: 3.0, duration: 2.05 },
      {
        // The four steps, held. Leave before Escape lands on the spinner.
        id: 'how-it-works',
        from: { id: 'how-it-works', offset: -2.3 },
        until: { id: 'how-it-works', offset: -0.15 },
        duration: 2.35
      }
    ]
  },
  setupScene(),
  discoverScene(),
  reviewScene(),
  moveScene(),
  searchScene(),
  chatScene(),
  relateScene(),
  // Omitted unless the capture marks `atlas` with a real map.
  atlasScene({ duration: 5.2 })
];

const SEARCH_LESSON = [
  {
    title: 'Search by meaning',
    cuts: [{ id: 'search', padBefore: 3.2, duration: 6.2, speed: 1.2 }]
  },
  {
    title: 'Choose who answers',
    cuts: [{ id: 'chat-persona', padBefore: 0.15, duration: 1.8 }]
  },
  {
    title: 'Ask your documents',
    cuts: [
      {
        id: 'chat-send',
        padBefore: 2.4,
        duration: 2.2,
        speed: 1.4,
        requires: 'chat'
      },
      { id: 'chat', padBefore: 0.35, duration: 8 }
    ]
  }
];

const GRAPH_LESSON = [
  {
    title: 'Zoom the graph',
    cuts: [
      { id: 'relate-zoom-in', padBefore: 0.45, duration: 3.2 },
      { id: 'relate-zoom-out', padBefore: 0.25, duration: 2.4 }
    ]
  },
  {
    title: 'Open a connection',
    cuts: [
      { id: 'relate', padBefore: 0.4, duration: 3.2 },
      { id: 'relate-2', padBefore: 0.3, duration: 3.2 }
    ]
  }
];

const CONNECT_LESSON = [
  {
    title: 'Advanced settings',
    cuts: [{ id: 'settings-advanced', padBefore: 0.4, duration: 2.2 }]
  },
  {
    title: 'Cloud keys stay optional',
    cuts: [
      { id: 'settings-provider', padBefore: 0.35, duration: 2.4 },
      { id: 'settings-consent', padBefore: 0.25, duration: 3.4 },
      { id: 'settings-key', padBefore: 0.3, duration: 2.6 }
    ]
  },
  {
    title: 'Turn on MCP',
    cuts: [
      { id: 'settings-mcp-on', padBefore: 0.4, duration: 2.4 },
      { id: 'settings-mcp-tools', padBefore: 0.2, duration: 2.6 },
      { id: 'settings-mcp-copy', padBefore: 0.25, duration: 2.2 }
    ]
  }
];

const MODELS_LESSON = [
  {
    title: 'Models already on this machine',
    cuts: [
      { id: 'models-ready', padBefore: 0, duration: 2.2 },
      { id: 'models-count', padBefore: 0.2, duration: 1.6 }
    ]
  },
  {
    title: 'Choose a local model',
    cuts: [
      { id: 'models-text', padBefore: 0.2, duration: 2.4 },
      { id: 'models-vision', padBefore: 0.15, duration: 2.0 },
      { id: 'models-embed', padBefore: 0.2, duration: 2.2 }
    ]
  },
  {
    title: 'Switching embeddings rebuilds search',
    cuts: [{ id: 'models-embed-dialog', padBefore: 0.25, duration: 3.2 }]
  },
  {
    title: 'Add another model later',
    cuts: [
      { id: 'models-gpu', padBefore: 0.2, duration: 1.6 },
      { id: 'models-catalog', padBefore: 0.25, duration: 2.2 }
    ]
  },
  {
    title: 'Name files as they are filed',
    cuts: [
      { id: 'naming-convention', padBefore: 0, duration: 2.2 },
      { id: 'naming-preview', padBefore: 0.3, duration: 2.8 }
    ]
  }
];

function lessonOutput(key, scenes) {
  return {
    scenes,
    size: [1920, 1080],
    zoomScale: 0.75,
    minScenes: 3,
    dest: () => path.join(OUT_DIR, 'lessons', `${key}.mp4`),
    frame: howToFilter,
    caption: lessonCaption,
    outro: { logo: 160, title: 72, sub: 32 }
  };
}

const LESSON_RAW = {
  search: 'library',
  // The library graph pass opened the duplicate dialog and the canvas behind
  // it collapsed, so the node click never landed. The highlight capture still
  // has the zoom and the two node clicks.
  graph: '.',
  connect: 'studio',
  models: 'studio'
};

/** Output-specific framing. The tour already shows the UI 1.33× larger, so it needs less push-in. */
const OUTPUTS = {
  short: {
    scenes: HOW_TO_SCENES,
    size: [1080, 1920],
    zoomScale: 0.75,
    storyFade: 0,
    outroFade: OUTRO_FADE,
    highQuality: true,
    dest: () => path.join(SHORT_DIR, 'stratosort-short.mp4'),
    frame: shortLetterboxFilter,
    caption: shortCaption,
    outro: { logo: 200, title: 80, sub: 36 }
  },
  howto: {
    scenes: HOW_TO_SCENES,
    size: [1920, 1080],
    zoomScale: 0.75,
    storyFade: 0,
    outroFade: OUTRO_FADE,
    highQuality: true,
    dest: () => path.join(OUT_DIR, 'how-to-use.mp4'),
    frame: howToFilter,
    caption: howToCaption,
    outro: { logo: 160, title: 72, sub: 32 }
  },
  search: lessonOutput('search', SEARCH_LESSON),
  graph: { ...lessonOutput('graph', GRAPH_LESSON), minScenes: 2 },
  connect: lessonOutput('connect', CONNECT_LESSON),
  models: lessonOutput('models-and-names', MODELS_LESSON)
};

// ---------------------------------------------------------------------------
// ffmpeg plumbing

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(`${cmd} ${args[0]} failed: ${err.slice(-1600)}`);
  }
  return result;
}

function probeVideo(file) {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-show_entries',
      'format=duration',
      '-of',
      'json',
      file
    ],
    { encoding: 'utf8' }
  );
  if (probe.status !== 0) {
    throw new Error(`ffprobe failed for ${file}`);
  }
  const info = JSON.parse(probe.stdout);
  return {
    width: Number(info.streams?.[0]?.width || 0),
    height: Number(info.streams?.[0]?.height || 0),
    duration: Number(info.format?.duration || 0)
  };
}

/** Paths inside a filter graph: forward slashes, and the drive colon escaped. */
function ffPath(file) {
  return file.replace(/\\/g, '/').replace(/:/g, '\\:');
}

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const num = (n) => Number(n.toFixed(4)).toString();

const X264 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '18'];
// Near-lossless, but still H.264 High profile. CRF 0 (true lossless) makes x264 emit the
// High 4:4:4 Predictive profile, which Chrome, Firefox and Safari cannot decode, so the published
// tour and Short would not play in a browser or on the docs site.
const X264_HIGH_QUALITY = [
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-pix_fmt',
  'yuv420p',
  '-preset',
  'slow',
  '-crf',
  '12'
];

function videoEncode(output) {
  return output?.highQuality ? X264_HIGH_QUALITY : X264;
}

// ---------------------------------------------------------------------------
// Capture

function loadCapture(rawDir = RAW_DIR) {
  const video = path.join(rawDir, 'app.webm');
  const actionsFile = path.join(rawDir, 'actions.json');
  if (!fs.existsSync(video) || !fs.existsSync(actionsFile)) {
    throw new Error(
      'No live tour capture. Run `npm run tour:record` first (writes tour-raw/app.webm + actions.json).'
    );
  }
  const payload = JSON.parse(fs.readFileSync(actionsFile, 'utf8'));
  const list = Array.isArray(payload) ? payload : payload.actions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('tour-raw/actions.json has no actions');
  }
  // Seconds the action clock runs ahead of the footage. The recorder measures it from
  // its clapper flash; when that is missing, measure a click by eye and pass --offset=N.
  const override = process.argv.find((arg) => arg.startsWith('--offset='));
  const videoOffset = override
    ? Number(override.slice('--offset='.length))
    : Number.isFinite(payload.videoOffset)
      ? payload.videoOffset
      : 0;
  if (!Number.isFinite(videoOffset)) {
    throw new Error(`Bad --offset value: ${override}`);
  }
  const actions = list.map((entry) => ({ ...entry, t: entry.t - videoOffset }));
  return { video, actions, videoOffset, meta: probeVideo(video) };
}

function findAction(actions, id) {
  const hit = actions.find((entry) => entry.id === id);
  if (!hit) {
    throw new Error(`Missing tour action "${id}". Re-run npm run tour:record.`);
  }
  return hit;
}

/**
 * Playwright scales the page to fit the video and pads the rest grey. Work out
 * the real UI rectangle from the recorded viewport so no output shows padding
 * or loses the bottom action bar.
 */
function contentRect(meta, actions) {
  const sample = actions.find((entry) => entry.viewportWidth > 0 && entry.viewportHeight > 0);
  if (!sample) {
    return { w: even(meta.width), h: even(meta.height), scale: 1 };
  }
  const scale = Math.min(meta.width / sample.viewportWidth, meta.height / sample.viewportHeight);
  return {
    w: even(Math.min(meta.width, sample.viewportWidth * scale)),
    h: even(Math.min(meta.height, sample.viewportHeight * scale)),
    scale
  };
}

/** VP8 GOPs in this capture exceed 12s. Early cuts need a long preroll or they snap to t=0. */
function seekPreroll(start) {
  return start < 120 ? 48 : 8;
}

function cutAnchors(cut) {
  const ids = [cut.from?.id, cut.until?.id, cut.requires];
  if (!cut.from) ids.push(cut.id);
  return ids.filter(Boolean);
}

function usableScenes(scenes, actions) {
  const landed = (id) => actions.some((entry) => entry.id === id && entry.ok !== false);
  const skipped = [];
  const kept = scenes
    .map((scene) => {
      const cuts = scene.cuts.filter((cut) => {
        const ok = cutAnchors(cut).every(landed);
        if (!ok) skipped.push(cut.id);
        return ok;
      });
      return { ...scene, cuts };
    })
    .filter((scene) => scene.cuts.length > 0);
  if (skipped.length) {
    console.warn(`[media] skipping ${skipped.join(', ')} (not captured or no on-screen payoff)`);
  }
  return kept;
}

/** Real-time window in the capture plus the time-lapse factor that fits it into cut.duration. */
function clipWindow(cut, actions, videoDuration) {
  let start;
  let real;
  if (cut.from) {
    start = findAction(actions, cut.from.id).t + (cut.from.offset || 0);
    real = findAction(actions, cut.until.id).t + (cut.until.offset || 0) - start;
  } else {
    start = findAction(actions, cut.id).t - (cut.padBefore || 0);
    real = cut.duration * (cut.speed || 1);
  }
  start = Math.max(0, start);
  real = Math.min(real, Math.max(0.8, videoDuration - start));
  const speed = real / cut.duration;
  return { start, real, speed, duration: real / speed };
}

// ---------------------------------------------------------------------------
// Camera

/**
 * Perlin smootherstep of a 0..1 progress expression: velocity and acceleration
 * are both zero at the ends, so a push-in starts and settles without a kick.
 */
function ease(p) {
  return `(${p}*${p}*${p}*(${p}*(${p}*6-15)+10))`;
}

/** Piecewise-eased value of `pick(key)` over keyframes, as an ffmpeg expression of `T`. */
function keyframeExpr(keys, pick, T) {
  let expr = num(pick(keys[keys.length - 1]));
  for (let i = keys.length - 2; i >= 0; i -= 1) {
    const a = keys[i];
    const b = keys[i + 1];
    const va = pick(a);
    const vb = pick(b);
    const p = `clip((${T}-${num(a.t)})/${num(b.t - a.t)},0,1)`;
    const seg = va === vb ? num(va) : `(${num(va)}+(${num(vb - va)})*${ease(p)})`;
    expr = `if(lt(${T},${num(b.t)}),${seg},${expr})`;
  }
  return expr;
}

/**
 * zoompan truncates its pan to whole input pixels, so a slow move on the 1440-wide
 * capture steps by a visible pixel or two every frame. Sampling a 4× lanczos
 * enlargement makes that step a quarter-pixel and keeps the magnified UI sharp.
 */
const CAMERA_SUPERSAMPLE = 4;

/**
 * Resolve camera keyframes into a zoompan filter, or null for a static wide shot.
 * Focus is the UI point kept centred (clamped so the frame never leaves the UI).
 */
function cameraFilter(cut, action, rect, duration, zoomScale) {
  if (!Array.isArray(cut.cam) || cut.cam.length === 0) return null;
  let z = 1;
  let focus = [rect.w / 2, rect.h / 2];
  const keys = cut.cam.map((key) => {
    if (Number.isFinite(key.z)) z = 1 + (key.z - 1) * zoomScale;
    if (key.focus === 'action' && action) {
      focus = [action.x * rect.scale, action.y * rect.scale];
    } else if (Array.isArray(key.focus)) {
      focus = [key.focus[0] * rect.w, key.focus[1] * rect.h];
    }
    const t = key.t < 0 ? duration + key.t : key.t;
    return { t, z, cx: focus[0], cy: focus[1] };
  });
  keys.sort((a, b) => a.t - b.t);
  for (let i = 1; i < keys.length; i += 1) {
    if (keys[i].t <= keys[i - 1].t) keys[i].t = keys[i - 1].t + 0.04;
  }
  if (keys.every((key) => key.z === 1)) return null;

  const T = `(on/${FPS})`;
  const zoom = keyframeExpr(keys, (key) => key.z, T);
  const cx = keyframeExpr(keys, (key) => key.cx * CAMERA_SUPERSAMPLE, T);
  const cy = keyframeExpr(keys, (key) => key.cy * CAMERA_SUPERSAMPLE, T);
  const sw = rect.w * CAMERA_SUPERSAMPLE;
  const sh = rect.h * CAMERA_SUPERSAMPLE;
  // zoompan renders the native frame from the enlarged source, so it is
  // downscaling (sharp) and its whole-pixel pan is a quarter-pixel here.
  return [
    `scale=${sw}:${sh}:flags=lanczos`,
    [
      `zoompan=z='${zoom}'`,
      `x='clip(${cx}-iw/zoom/2,0,iw-iw/zoom)'`,
      `y='clip(${cy}-ih/zoom/2,0,ih-ih/zoom)'`,
      `d=1:s=${rect.w}x${rect.h}:fps=${FPS}`
    ].join(':')
  ].join(',');
}

// ---------------------------------------------------------------------------
// Framing

/** Whole UI centered on 9:16; the blurred fill is the UI body, not the navbar. */
function shortLetterboxFilter() {
  return [
    '[ui]split[srcbg][srcfg]',
    `[srcbg]crop=iw:ih-96:0:96,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,${BLUR_BG}[bg]`,
    '[srcfg]scale=1080:-2[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p'
  ].join(';');
}

/** UI on top, an ink bar underneath for the step title so nothing in the product is covered. */
function howToFilter() {
  const stageH = 1080 - 84;
  return [
    '[ui]split[srcbg][srcfg]',
    `[srcbg]scale=1920:${stageH}:force_original_aspect_ratio=increase,crop=1920:${stageH},${BLUR_BG}[bg]`,
    `[srcfg]scale=1920:${stageH}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,eq=contrast=1.02:saturation=1.01[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[stage]',
    `[stage]pad=1920:1080:0:0:color=${INK},format=yuv420p`
  ].join(';');
}

function extractClip(ctx, cut, name) {
  const { workDir, video, actions, meta, rect, output } = ctx;
  const { start, real, speed, duration } = clipWindow(cut, actions, meta.duration);
  const action = cut.from ? null : findAction(actions, cut.id);
  const coarse = Math.max(0, start - seekPreroll(start));
  const fine = start - coarse;
  const camera = cameraFilter(cut, action, rect, duration, output.zoomScale);

  const source = [
    `trim=start=${num(fine)}:duration=${num(real)}`,
    `setpts=(PTS-STARTPTS)/${num(speed)}`,
    `fps=${FPS}`,
    `crop=${rect.w}:${rect.h}:0:0`
  ];
  if (camera) source.push(camera);
  const graph = `[0:v]${source.join(',')}[ui];${output.frame()}`;

  console.log(
    `[media] ${name} ${cut.id} @ ${start.toFixed(2)} +${real.toFixed(2)}s` +
      `${speed > 1.01 ? ` ×${speed.toFixed(1)}` : ''}${camera ? ' cam' : ''}`
  );
  const out = path.join(workDir, `${name}.mp4`);
  run('ffmpeg', [
    '-y',
    '-ss',
    num(coarse),
    '-i',
    video,
    '-filter_complex',
    graph,
    '-t',
    num(duration),
    '-an',
    ...videoEncode(output),
    out
  ]);
  return out;
}

// ---------------------------------------------------------------------------
// Captions

const FONTS = {
  win32: {
    bold: ['C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/arialbd.ttf'],
    regular: ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf']
  },
  darwin: {
    bold: [
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
      '/System/Library/Fonts/Helvetica.ttc'
    ],
    regular: ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc']
  },
  linux: {
    bold: ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    regular: ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
  }
};

function resolveFonts() {
  const table = FONTS[process.platform] || FONTS.linux;
  const pick = (envName, candidates) => {
    const list = [process.env[envName], ...candidates].filter(Boolean);
    return list.find((file) => fs.existsSync(file)) || null;
  };
  const bold = pick('STRATOSORT_TOUR_FONT_BOLD', table.bold);
  const regular = pick('STRATOSORT_TOUR_FONT', table.regular) || bold;
  if (!bold) {
    console.warn(
      '[media] no TrueType font found; captions skipped (set STRATOSORT_TOUR_FONT_BOLD)'
    );
  }
  return { bold, regular };
}

let textFileCounter = 0;
function textFile(workDir, text) {
  textFileCounter += 1;
  const file = path.join(workDir, `caption-${textFileCounter}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function drawText(ctx, text, { font, size, color, x, y, alpha, box, shadow }) {
  const parts = [
    `fontfile='${ffPath(font)}'`,
    `textfile='${ffPath(textFile(ctx.workDir, text))}'`,
    `fontsize=${size}`,
    `fontcolor=${color}`,
    `x=${x}`,
    `y=${y}`
  ];
  if (alpha) parts.push(`alpha='${alpha}'`);
  if (box) parts.push(`box=1:boxcolor=${box.color}:boxborderw=${box.pad}`);
  if (shadow)
    parts.push(
      `shadowcolor=${INK}@0.85:shadowx=0:shadowy=${shadow}:borderw=2:bordercolor=${INK}@0.6`
    );
  return `drawtext=${parts.join(':')}`;
}

/**
 * Fade in after the scene crossfade has settled and out before the next one
 * starts, so two captions never mix. `hold` caps how long the caption stays.
 */
function fadeAlpha(sceneDuration, hold = Infinity) {
  const lead = SCENE_XFADE;
  const start = num(lead);
  const end = num(Math.min(sceneDuration - lead, lead + hold));
  return `if(lt(t,${start}),0,if(lt(t,${start}+0.3),(t-${start})/0.3,if(lt(t,${end}-0.3),1,max(0,(${end}-t)/0.3))))`;
}

/** Visible from the first frame of the scene. The scene change and its caption land together. */
function alignedAlpha(sceneDuration) {
  const fade = 0.12;
  const end = num(Math.max(sceneDuration - 0.2, fade + 0.2));
  return `if(lt(t,${fade}),t/${fade},if(lt(t,${end}),1,max(0,(${num(sceneDuration)}-t)/0.2)))`;
}

/** Short: step + title in the blur zone above the UI, quiet tagline below it. */
function shortCaption(ctx, scene, index, sceneDuration) {
  const alpha = alignedAlpha(sceneDuration);
  return [
    drawText(ctx, `STEP ${index + 1}`, {
      font: ctx.fonts.regular,
      size: 30,
      color: '0x8fb3d9',
      x: '(w-text_w)/2',
      y: 462,
      alpha,
      shadow: 2
    }),
    drawText(ctx, scene.title, {
      font: ctx.fonts.bold,
      size: 66,
      color: 'white',
      x: '(w-text_w)/2',
      y: 508,
      alpha,
      shadow: 3
    }),
    drawText(ctx, 'StratoSort  ·  100% on-device AI', {
      font: ctx.fonts.regular,
      size: 34,
      color: '0xa9b7c9',
      x: '(w-text_w)/2',
      y: 1336,
      alpha,
      shadow: 2
    })
  ].join(',');
}

/** Lessons: the step title sits in the top corner so it does not cover zoom controls, previews, or the Close button. */
function lessonCaption(ctx, scene, index, sceneDuration) {
  return drawText(ctx, `${index + 1}  ·  ${scene.title}`, {
    font: ctx.fonts.bold,
    size: 36,
    color: 'white',
    x: 36,
    y: 86,
    alpha: fadeAlpha(sceneDuration, 2.6),
    box: { color: `${INK}@0.78`, pad: 14 }
  });
}

/** Tour: the step title sits in the ink bar under the picture. */
function howToCaption(ctx, scene, index, sceneDuration) {
  return drawText(ctx, `${index + 1}   ${scene.title}`, {
    font: ctx.fonts.bold,
    size: 32,
    color: 'white',
    x: '(w-text_w)/2',
    y: '1080-42-th/2',
    alpha: alignedAlpha(sceneDuration)
  });
}

// ---------------------------------------------------------------------------
// Assembly

function concatFiles(clips, dest, vf, encode) {
  const list = path.join(path.dirname(dest), `${path.basename(dest, '.mp4')}.txt`);
  fs.writeFileSync(list, clips.map((file) => `file '${file.replace(/\\/g, '/')}'`).join('\n'));
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', list];
  if (vf) args.push('-vf', vf);
  args.push('-an', ...(encode || X264), dest);
  run('ffmpeg', args);
  return dest;
}

function buildScene(ctx, scene, index) {
  const name = `${ctx.key}-s${String(index).padStart(2, '0')}`;
  const encode = videoEncode(ctx.output);
  const clips = scene.cuts.map((cut, i) => extractClip(ctx, cut, `${name}-c${i}`));
  const rough = concatFiles(clips, path.join(ctx.workDir, `${name}-rough.mp4`), null, encode);
  if (!ctx.fonts.bold) return rough;
  const { duration } = probeVideo(rough);
  return concatFiles(
    [rough],
    path.join(ctx.workDir, `${name}.mp4`),
    ctx.output.caption(ctx, scene, index, duration),
    encode
  );
}

function buildOutro(ctx) {
  const [w, h] = ctx.output.size;
  const { logo, title, sub } = ctx.output.outro;
  const out = path.join(ctx.workDir, `${ctx.key}-outro.mp4`);
  const hasLogo = fs.existsSync(LOGO);
  const chain = [];
  if (hasLogo) {
    chain.push(
      `[1:v]scale=${logo}:-1[logo]`,
      `[0:v][logo]overlay=(W-w)/2:${h / 2 - logo - 40}[base]`
    );
  }
  const text = [];
  if (ctx.fonts.bold) {
    text.push(
      drawText(ctx, 'StratoSort', {
        font: ctx.fonts.bold,
        size: title,
        color: 'white',
        x: '(w-text_w)/2',
        y: h / 2 - 10
      }),
      drawText(ctx, 'Private, on-device AI for your files', {
        font: ctx.fonts.regular,
        size: sub,
        color: '0xa9b7c9',
        x: '(w-text_w)/2',
        y: h / 2 + title + 20
      })
    );
  }
  const last = hasLogo ? '[base]' : '[0:v]';
  chain.push(`${last}${text.length ? text.join(',') : 'null'},format=yuv420p[v]`);

  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=${INK}:s=${w}x${h}:r=${FPS}:d=${OUTRO_SECONDS}`
  ];
  if (hasLogo) args.push('-i', LOGO);
  args.push(
    '-filter_complex',
    chain.join(';'),
    '-map',
    '[v]',
    '-t',
    num(OUTRO_SECONDS),
    ...videoEncode(ctx.output),
    out
  );
  run('ffmpeg', args);
  return out;
}

/** Hard-cut the story. Dissolve only into the end card, then fade the whole piece out. */
function assemble(ctx, sceneFiles, dest) {
  const inputs = [...sceneFiles, buildOutro(ctx)];
  const durations = inputs.map((file) => probeVideo(file).duration);
  const storyFade = ctx.output.storyFade ?? SCENE_XFADE;
  const outroFade = ctx.output.outroFade ?? storyFade;
  const [w, h] = ctx.output.size;
  const encode = videoEncode(ctx.output);
  const storyCount = inputs.length - 1;
  const chain = [];
  let storyLabel = '[0:v]';
  let elapsed = durations[0];

  if (storyFade <= 0) {
    const pads = inputs
      .slice(0, storyCount)
      .map((_, i) => `[${i}:v]`)
      .join('');
    chain.push(`${pads}concat=n=${storyCount}:v=1:a=0[story]`);
    storyLabel = '[story]';
    elapsed = durations.slice(0, storyCount).reduce((sum, value) => sum + value, 0);
  } else {
    for (let i = 1; i < storyCount; i += 1) {
      const offset = elapsed - storyFade;
      const next = `[s${i}]`;
      chain.push(
        `${storyLabel}[${i}:v]xfade=transition=fade:duration=${storyFade}:offset=${num(offset)}${next}`
      );
      storyLabel = next;
      elapsed = offset + durations[i];
    }
  }

  const outroOffset = Math.max(0, elapsed - outroFade);
  chain.push(`${storyLabel}fps=${FPS},settb=1/${FPS}[storytb]`);
  chain.push(`[${storyCount}:v]fps=${FPS},settb=1/${FPS}[outrotb]`);
  chain.push(
    `[storytb][outrotb]xfade=transition=fade:duration=${outroFade}:offset=${num(outroOffset)}[joined]`
  );
  elapsed = outroOffset + durations[storyCount];
  chain.push(
    `[joined]fade=t=in:st=0:d=0.25,fade=t=out:st=${num(elapsed - 0.5)}:d=0.5,format=yuv420p[v]`
  );

  const args = ['-y'];
  inputs.forEach((file) => args.push('-i', file));
  args.push(
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex',
    chain.join(';'),
    '-map',
    '[v]',
    '-map',
    `${inputs.length}:a`,
    '-t',
    num(elapsed),
    ...encode,
    '-r',
    String(FPS),
    '-s',
    `${w}x${h}`,
    '-c:a',
    'aac',
    '-b:a',
    ctx.output.highQuality ? '320k' : '128k',
    '-movflags',
    '+faststart',
    dest
  );
  run('ffmpeg', args);
  return elapsed;
}

function composeOutput(base, key) {
  const output = OUTPUTS[key];
  const ctx = { ...base, key, output };
  const scenes = usableScenes(output.scenes, ctx.actions);
  if (scenes.length < (output.minScenes || 4)) {
    throw new Error(`Live capture is missing too many ${key} beats. Re-run npm run tour:record.`);
  }
  console.log(`[media] composing ${key}: ${scenes.length} scenes…`);
  const files = scenes.map((scene, i) => buildScene(ctx, scene, i));
  const dest = output.dest();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const total = assemble(ctx, files, dest);
  console.log(`[media] ${key} → ${dest} (${total.toFixed(1)}s)`);
}

function parseOnly() {
  const topicArg = process.argv.find((arg) => arg.startsWith('--topic='));
  if (topicArg) {
    const topic = topicArg.slice('--topic='.length);
    if (topic === 'lessons') return Object.keys(LESSON_RAW);
    if (!LESSON_RAW[topic]) {
      throw new Error(
        `Unknown compose topic "${topic}". Use search, graph, connect, models, or lessons.`
      );
    }
    return [topic];
  }
  if (process.argv.includes('--short')) return ['short'];
  if (process.argv.includes('--howto')) return ['howto'];
  return ['short', 'howto'];
}

function composeKeys(rawDir, keys) {
  const { video, actions, videoOffset, meta } = loadCapture(rawDir);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-media-'));
  const rect = contentRect(meta, actions);
  const fonts = resolveFonts();
  console.log(
    `[media] live capture ${meta.width}x${meta.height} ${meta.duration.toFixed(1)}s, ${actions.length} mouse actions, ui ${rect.w}x${rect.h}, clock offset ${videoOffset}s`
  );
  const base = { workDir, video, actions, meta, rect, fonts };
  keys.forEach((key) => composeOutput(base, key));
}

function main() {
  run('ffmpeg', ['-version']);
  const keys = parseOnly();
  const highlight = keys.filter((key) => !LESSON_RAW[key]);
  if (highlight.length) composeKeys(RAW_DIR, highlight);
  const byRaw = new Map();
  keys
    .filter((key) => LESSON_RAW[key])
    .forEach((key) => {
      const dir = LESSON_RAW[key] === '.' ? RAW_DIR : path.join(RAW_DIR, LESSON_RAW[key]);
      const group = byRaw.get(dir) || [];
      group.push(key);
      byRaw.set(dir, group);
    });
  byRaw.forEach((group, dir) => composeKeys(dir, group));
}

main();
