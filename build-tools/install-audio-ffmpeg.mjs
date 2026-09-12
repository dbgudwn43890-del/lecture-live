import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadPinnedSource } from './download-pinned-source.mjs';

// Official release signature verified against FFmpeg's published signing key:
// FCF986EA15E6E293A5644F10B4322F04D67658D8. Pin the signed archive, not "latest".
// https://ffmpeg.org/download.html#release_8.1
const VERSION = '8.1.2';
const SHA256 = '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c';
const sourceUrl = `https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(root, '.ffmpeg');
const binary = join(destination, 'ffmpeg');
const identity = `${VERSION}:${SHA256}:${process.platform}:${process.arch}:audio-v1`;
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The verified audio decoder currently requires macOS or Linux.');

try {
  if (await readFile(join(destination, 'build-id'), 'utf8') === identity
    && execFileSync(binary, ['-version'], { encoding: 'utf8' }).startsWith(`ffmpeg version ${VERSION}`)) {
    console.log(`Verified audio decoder ${VERSION} is ready.`);
    process.exit(0);
  }
} catch { /* A missing or incompatible cache is rebuilt. */ }

const directory = await mkdtemp(join(tmpdir(), 'lecue-ffmpeg-build-'));
const logPath = join(root, '.ffmpeg-build.log');
async function run(command, args, cwd) {
  try {
    const output = execFileSync(command, args, { cwd, timeout: 900_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (output) await writeFile(logPath, output);
  } catch (error) {
    const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    await writeFile(logPath, output);
    throw new Error(`Audio decoder build failed (${command}). ${output.slice(-5000)}`);
  }
}
try {
  console.log(`Building signed FFmpeg ${VERSION} with audio-only codecs (no network/video).`);
  const archive = await downloadPinnedSource(sourceUrl, SHA256, {
    archivePath: join(root, 'build-tools', 'vendor', `ffmpeg-${VERSION}.tar.xz`),
  });
  const archivePath = join(directory, 'source.tar.xz');
  await writeFile(archivePath, archive);
  await run('tar', ['-xJf', archivePath, '-C', directory], directory);
  const source = join(directory, `ffmpeg-${VERSION}`);
  await run(join(source, 'configure'), [
    '--disable-autodetect', '--disable-everything', '--disable-network', '--disable-doc', '--disable-debug',
    '--disable-shared', '--enable-static', '--enable-small', '--disable-x86asm', '--disable-audiotoolbox',
    '--disable-videotoolbox', '--disable-securetransport', '--disable-iconv', '--disable-ffprobe', '--disable-ffplay',
    '--enable-ffmpeg', '--enable-protocol=file',
    '--enable-demuxer=mp3,wav,mov,matroska', '--enable-muxer=flac',
    '--enable-decoder=mp3,mp3float,aac,aac_fixed,alac,opus,vorbis,flac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_u8,pcm_s8,pcm_alaw,pcm_mulaw',
    '--enable-parser=mpegaudio,aac,opus,vorbis,flac', '--enable-encoder=flac',
    '--enable-filter=aresample,asetpts,anull,aformat',
  ], source);
  await run('make', ['-j', String(Math.min(8, availableParallelism())), 'ffmpeg'], source);
  await mkdir(destination, { recursive: true });
  await copyFile(join(source, 'ffmpeg'), binary);
  await chmod(binary, 0o755);
  await copyFile(join(source, 'COPYING.LGPLv2.1'), join(destination, 'COPYING.LGPLv2.1'));
  const version = execFileSync(binary, ['-version'], { encoding: 'utf8' });
  if (!version.startsWith(`ffmpeg version ${VERSION}`)) throw new Error('FFmpeg binary version mismatch');
  await writeFile(join(destination, 'build-id'), identity);
  console.log(`Verified audio decoder ${VERSION} built successfully.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
