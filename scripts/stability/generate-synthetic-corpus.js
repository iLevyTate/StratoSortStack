#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value = 'true'] = token.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileWithSize(filePath, targetBytes, header) {
  const headerText = `${header}\n`;
  const chunk = 'StratoSort synthetic fixture content line for repeatable benchmark runs.\n';
  let content = headerText;

  while (Buffer.byteLength(content, 'utf8') < targetBytes) {
    content += chunk;
  }

  const finalBuffer = Buffer.from(content.slice(0, targetBytes), 'utf8');
  fs.writeFileSync(filePath, finalBuffer);
}

function selectExtension(index) {
  const extensions = ['.txt', '.md', '.json', '.csv', '.log', '.js'];
  return extensions[index % extensions.length];
}

function createDataset(options) {
  const { datasetDir, count, sizeBytes, depth, label } = options;

  ensureDir(datasetDir);
  let totalBytes = 0;
  const created = [];

  for (let i = 0; i < count; i += 1) {
    const levelA = `group-${String(Math.floor(i / 100)).padStart(3, '0')}`;
    const levelB = `bucket-${String(i % 25).padStart(2, '0')}`;
    const levelC = `tier-${String(i % 10).padStart(2, '0')}`;

    const dirs = [levelA];
    if (depth >= 2) dirs.push(levelB);
    if (depth >= 3) dirs.push(levelC);

    const fileDir = path.join(datasetDir, ...dirs);
    ensureDir(fileDir);

    const ext = selectExtension(i);
    const fileName = `fixture-${String(i).padStart(5, '0')}${ext}`;
    const filePath = path.join(fileDir, fileName);
    const header = `dataset=${label};index=${i};path=${path.relative(datasetDir, filePath)}`;

    writeFileWithSize(filePath, sizeBytes, header);
    totalBytes += sizeBytes;
    created.push(path.relative(datasetDir, filePath));
  }

  return {
    label,
    fileCount: count,
    fileSizeBytes: sizeBytes,
    totalBytes,
    depth,
    sampleFiles: created.slice(0, 5)
  };
}

function writeManifest(outputDir, manifest) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const outputDir = path.resolve(
    args.output || path.join(repoRoot, '.tmp', 'stability', 'synthetic-corpus')
  );
  const smallCount = toInt(args['small-count'], 120);
  const largeCount = toInt(args['large-count'], 1500);
  const smallSizeKb = toInt(args['small-size-kb'], 16);
  const largeSizeKb = toInt(args['large-size-kb'], 64);
  const smallDepth = toInt(args['small-depth'], 2);
  const largeDepth = toInt(args['large-depth'], 3);

  ensureDir(outputDir);

  const startedAt = Date.now();
  const smallResult = createDataset({
    datasetDir: path.join(outputDir, 'S1-small-folder-import'),
    count: smallCount,
    sizeBytes: smallSizeKb * 1024,
    depth: smallDepth,
    label: 'S1-small-folder-import'
  });
  const largeResult = createDataset({
    datasetDir: path.join(outputDir, 'S2-large-folder-import'),
    count: largeCount,
    sizeBytes: largeSizeKb * 1024,
    depth: largeDepth,
    label: 'S2-large-folder-import'
  });
  const elapsedMs = Date.now() - startedAt;

  const manifest = {
    generatedAt: new Date().toISOString(),
    outputDir,
    elapsedMs,
    datasets: [smallResult, largeResult]
  };

  const manifestPath = writeManifest(outputDir, manifest);

  console.log('Synthetic corpus generated.');
  console.log(`Output: ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(
    `S1 files: ${smallResult.fileCount}, S2 files: ${largeResult.fileCount}, total MB: ${(
      (smallResult.totalBytes + largeResult.totalBytes) /
      (1024 * 1024)
    ).toFixed(2)}`
  );
}

main();
