const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { resolveSourceLogoPath } = require('./resolveSourceLogo');

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/**
 * 24-bit BMP (BGR, bottom-up) for NSIS MUI — PNG side images often render blank in the wizard.
 */
function encodeBmp24(width, height, rgbaBuffer) {
  if (rgbaBuffer.length !== width * height * 4) {
    throw new Error(`encodeBmp24: expected ${width * height * 4} bytes, got ${rgbaBuffer.length}`);
  }
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = rowStride * height;
  const fileSize = 14 + 40 + imageSize;
  const out = Buffer.alloc(fileSize, 0);
  out.write('BM', 0);
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(imageSize, 34);
  const pixOff = 54;
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const i = (srcY * width + x) * 4;
      const o = pixOff + y * rowStride + x * 3;
      out[o] = rgbaBuffer[i + 2];
      out[o + 1] = rgbaBuffer[i + 1];
      out[o + 2] = rgbaBuffer[i];
    }
  }
  return out;
}

async function writeBrandedBmp(
  srcPngPath,
  outPath,
  width,
  height,
  background = { r: 255, g: 255, b: 255, alpha: 1 }
) {
  const rgba = await sharp(srcPngPath)
    .resize(width, height, { fit: 'contain', background })
    .flatten({ background })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const bmp = encodeBmp24(width, height, rgba);
  await fs.promises.writeFile(outPath, bmp);
  console.log(`  Generated: ${path.basename(outPath)} (${width}x${height} BMP)`);
}

// ---------------------------------------------------------------------------
// Portable splash (portable.splashImage in electron-builder.json)
//
// The portable stub unpacks the whole app into %TEMP% on every launch, which
// takes a while, and without a splash it runs silently with nothing on screen.
// electron-builder shows this bitmap through the NSIS BgImage plugin until the
// app process starts. The text is drawn with a built-in 5x7 pixel font so the
// output is byte-identical on every machine (no system fonts involved).
// ---------------------------------------------------------------------------

const SPLASH_WIDTH = 400;
const SPLASH_HEIGHT = 200;

// Palette derived from assets/icons/StratoSortStackLogo.svg (amber, mid blue,
// dark blue); the background is the dark blue darkened so the disc stays visible.
const SPLASH_COLORS = {
  background: { r: 6, g: 26, b: 38 },
  title: { r: 255, g: 255, b: 255 },
  body: { r: 196, g: 216, b: 228 },
  track: { r: 33, g: 118, b: 159 },
  accent: { r: 221, g: 159, b: 46 }
};

/**
 * 5x7 glyphs, one byte per row, bit 4 is the leftmost column. Uppercase only:
 * the splash renders its copy in caps so no lowercase set is needed.
 */
const GLYPHS_5X7 = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x11, 0x19, 0x15, 0x13, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x11, 0x0a, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  ',': [0x00, 0x00, 0x00, 0x00, 0x0c, 0x04, 0x08],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  "'": [0x0c, 0x04, 0x08, 0x00, 0x00, 0x00, 0x00],
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

function fillRect(canvas, x, y, width, height, color) {
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      if (px < 0 || py < 0 || px >= SPLASH_WIDTH || py >= SPLASH_HEIGHT) continue;
      const o = (py * SPLASH_WIDTH + px) * 4;
      canvas[o] = color.r;
      canvas[o + 1] = color.g;
      canvas[o + 2] = color.b;
      canvas[o + 3] = 255;
    }
  }
}

/** Draws `text` in caps at (x, y); each glyph pixel becomes a scale x scale block. */
function drawText(canvas, text, x, y, scale, color) {
  let cursor = x;
  for (const ch of text.toUpperCase()) {
    const rows = GLYPHS_5X7[ch];
    if (!rows) {
      throw new Error(`generatePortableSplash: no glyph for ${JSON.stringify(ch)} in "${text}"`);
    }
    rows.forEach((bits, row) => {
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        if (bits & (1 << (GLYPH_WIDTH - 1 - col))) {
          fillRect(canvas, cursor + col * scale, y + row * scale, scale, scale, color);
        }
      }
    });
    cursor += GLYPH_ADVANCE * scale;
  }
}

/** Width in pixels that drawText would use for `text` at `scale`. */
function measureText(text, scale) {
  return (text.length * GLYPH_ADVANCE - 1) * scale;
}

/**
 * 400x200 24-bit BMP: logo disc, product name, a short note that unpacking
 * happens on every start, and a static progress-bar-like band.
 */
async function generatePortableSplash(srcLogoPath, outPath) {
  const { background, title, body, track, accent } = SPLASH_COLORS;
  const canvas = Buffer.alloc(SPLASH_WIDTH * SPLASH_HEIGHT * 4);
  fillRect(canvas, 0, 0, SPLASH_WIDTH, SPLASH_HEIGHT, background);

  const margin = 24;
  const logoSize = 56;
  const logoRgba = await sharp(srcLogoPath)
    .resize(logoSize, logoSize, { fit: 'contain', background: { ...background, alpha: 1 } })
    .flatten({ background })
    .ensureAlpha()
    .raw()
    .toBuffer();
  for (let y = 0; y < logoSize; y++) {
    const src = y * logoSize * 4;
    const dst = ((margin + y) * SPLASH_WIDTH + margin) * 4;
    logoRgba.copy(canvas, dst, src, src + logoSize * 4);
  }

  const titleScale = 2;
  const titleY = margin + Math.floor((logoSize - GLYPH_HEIGHT * titleScale) / 2);
  drawText(canvas, 'StratoSort Stack', margin + logoSize + 16, titleY, titleScale, title);

  const bodyScale = 2;
  const bodyLines = ['Unpacking portable app.', 'This takes about a minute', 'on every start.'];
  const bodyLineHeight = GLYPH_HEIGHT * bodyScale + 6;
  bodyLines.forEach((line, i) => {
    if (measureText(line, bodyScale) > SPLASH_WIDTH - margin * 2) {
      throw new Error(`generatePortableSplash: line too wide for ${SPLASH_WIDTH}px: "${line}"`);
    }
    drawText(canvas, line, margin, 100 + i * bodyLineHeight, bodyScale, body);
  });

  const bandY = SPLASH_HEIGHT - margin - 10;
  const bandWidth = SPLASH_WIDTH - margin * 2;
  fillRect(canvas, margin, bandY, bandWidth, 10, track);
  fillRect(canvas, margin, bandY, Math.floor(bandWidth * 0.4), 10, accent);

  await fs.promises.writeFile(outPath, encodeBmp24(SPLASH_WIDTH, SPLASH_HEIGHT, canvas));
  console.log(
    `  Generated: ${path.basename(outPath)} (${SPLASH_WIDTH}x${SPLASH_HEIGHT} BMP, portable splash)`
  );
}

async function main() {
  const projectRoot = process.cwd();
  const assetsDir = path.join(projectRoot, 'assets');
  const logoPng = resolveSourceLogoPath(projectRoot);

  // In release / --require-logo mode, a missing source logo is a fatal
  // error — the NSIS installer falls back to default branding and we ship
  // an unbranded wizard without any warning. Outside that mode, keep the
  // soft skip so `npm ci` on a stripped clone doesn't block the build.
  const requireLogo = process.argv.includes('--require-logo') || process.env.CI === 'true';

  if (!logoPng) {
    const msg = '[nsis-assets] No source logo found under assets/; skipping BMP generation';
    if (requireLogo) {
      console.error(
        `${msg}\n[nsis-assets] --require-logo / CI=true is set; refusing to ship unbranded installer.`
      );
      process.exit(1);
    }
    console.log(msg);
    return;
  }

  await ensureDir(assetsDir);

  // Filenames and sizes expected by electron-builder (buildResources = assets).
  // See app-builder-lib NsisTarget.configureDefines — assisted installer looks for these in build resources.
  await writeBrandedBmp(logoPng, path.join(assetsDir, 'installerHeader.bmp'), 150, 57);
  await writeBrandedBmp(logoPng, path.join(assetsDir, 'installerSidebar.bmp'), 164, 314);
  await writeBrandedBmp(logoPng, path.join(assetsDir, 'uninstallerSidebar.bmp'), 164, 314);

  // portable.splashImage in electron-builder.json (shown while the portable stub unpacks).
  await generatePortableSplash(logoPng, path.join(assetsDir, 'portable-splash.bmp'));

  console.log('[nsis-assets] Generated NSIS BMP assets in:', assetsDir);
}

main().catch((err) => {
  console.error('[nsis-assets] Error generating assets', err);
  process.exit(1);
});
