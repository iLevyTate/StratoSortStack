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

  console.log('[nsis-assets] Generated NSIS BMP assets in:', assetsDir);
}

main().catch((err) => {
  console.error('[nsis-assets] Error generating assets', err);
  process.exit(1);
});
