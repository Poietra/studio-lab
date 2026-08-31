import { validateExportAudioWav } from "../engine/export-audio-wav";
import { MAX_EXPORT_WAV_BYTES } from "../engine/export-worker-protocol";
import { ingestProjectAudioWav, PROJECT_AUDIO_SAMPLE_RATE_HZ, type ProjectAudioTrack } from "./project-audio-track";

const PCM_WAV_HEADER_BYTES = 44;
const PCM_WAV_BYTES_PER_SAMPLE = 2;

type DecodedProjectAudio = Readonly<{
  getChannelData: (channel: number) => Float32Array;
  length: number;
  numberOfChannels: number;
  sampleRate: number;
}>;

type ProjectAudioFileIngestDependencies = Readonly<{
  decodeMp3?: (bytes: ArrayBuffer) => Promise<DecodedProjectAudio>;
  validateWav?: (wavBytes: ArrayBuffer) => Promise<number>;
}>;

function projectAudioFileKind(file: File): "mp3" | "wav" | null {
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".wav")) return "wav";
  if (name.endsWith(".mp3")) return "mp3";
  const mediaType = file.type.trim().toLowerCase();
  if (mediaType === "audio/wav" || mediaType === "audio/x-wav") return "wav";
  if (mediaType === "audio/mpeg" || mediaType === "audio/mp3") return "mp3";
  return null;
}

async function decodeMp3InBrowser(bytes: ArrayBuffer): Promise<DecodedProjectAudio> {
  if (typeof AudioContext === "undefined") throw new TypeError("This browser cannot decode MP3 audio.");
  const context = new AudioContext({ sampleRate: PROJECT_AUDIO_SAMPLE_RATE_HZ });
  try {
    return await context.decodeAudioData(bytes.slice(0));
  } catch (cause) {
    throw new TypeError("Studio could not decode the selected MP3 file.", { cause });
  } finally {
    await context.close();
  }
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

function pcm16Sample(sample: number) {
  const bounded = Math.max(-1, Math.min(1, sample));
  return Math.round(bounded < 0 ? bounded * 32_768 : bounded * 32_767);
}

function sampleAtRate(source: Float32Array, targetIndex: number, sourceRate: number) {
  if (sourceRate === PROJECT_AUDIO_SAMPLE_RATE_HZ) return source[targetIndex] ?? 0;
  const sourcePosition = (targetIndex * sourceRate) / PROJECT_AUDIO_SAMPLE_RATE_HZ;
  const leftIndex = Math.min(source.length - 1, Math.floor(sourcePosition));
  const rightIndex = Math.min(source.length - 1, leftIndex + 1);
  const fraction = sourcePosition - leftIndex;
  return (source[leftIndex] ?? 0) * (1 - fraction) + (source[rightIndex] ?? 0) * fraction;
}

function encodeCanonicalPcmWav(decoded: DecodedProjectAudio) {
  const { length, numberOfChannels, sampleRate } = decoded;
  if (numberOfChannels !== 1 && numberOfChannels !== 2) {
    throw new TypeError("MP3 project audio must decode to mono or stereo.");
  }
  if (!Number.isSafeInteger(length) || length < 1 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError("The decoded MP3 audio has invalid sample data.");
  }
  const sourceChannels = Array.from({ length: numberOfChannels }, (_, channel) => decoded.getChannelData(channel));
  if (sourceChannels.some((samples) => samples.length !== length)) {
    throw new TypeError("The decoded MP3 channel lengths do not match.");
  }
  const targetSampleFrames = Math.round((length * PROJECT_AUDIO_SAMPLE_RATE_HZ) / sampleRate);
  const dataBytes = targetSampleFrames * numberOfChannels * PCM_WAV_BYTES_PER_SAMPLE;
  const totalBytes = PCM_WAV_HEADER_BYTES + dataBytes;
  if (!Number.isSafeInteger(targetSampleFrames) || targetSampleFrames < 1 || totalBytes > MAX_EXPORT_WAV_BYTES) {
    throw new TypeError(`The decoded MP3 audio exceeds the ${MAX_EXPORT_WAV_BYTES / (1024 * 1024)} MiB WAV limit.`);
  }

  const wavBytes = new ArrayBuffer(totalBytes);
  const view = new DataView(wavBytes);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, totalBytes - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, PROJECT_AUDIO_SAMPLE_RATE_HZ, true);
  view.setUint32(28, PROJECT_AUDIO_SAMPLE_RATE_HZ * numberOfChannels * PCM_WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(32, numberOfChannels * PCM_WAV_BYTES_PER_SAMPLE, true);
  view.setUint16(34, PCM_WAV_BYTES_PER_SAMPLE * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let byteOffset = PCM_WAV_HEADER_BYTES;
  for (let frame = 0; frame < targetSampleFrames; frame += 1) {
    for (const channel of sourceChannels) {
      view.setInt16(byteOffset, pcm16Sample(sampleAtRate(channel, frame, sampleRate)), true);
      byteOffset += PCM_WAV_BYTES_PER_SAMPLE;
    }
  }
  return wavBytes;
}

export async function ingestProjectAudioFile(
  file: File,
  dependencies: ProjectAudioFileIngestDependencies = {},
): Promise<ProjectAudioTrack> {
  const kind = projectAudioFileKind(file);
  if (kind === "wav") return ingestProjectAudioWav(file, dependencies.validateWav ?? validateExportAudioWav);
  if (kind !== "mp3") throw new TypeError("Choose a WAV or MP3 project audio file.");
  if (file.size < 1 || file.size > MAX_EXPORT_WAV_BYTES) {
    throw new TypeError(`Choose a non-empty MP3 file no larger than ${MAX_EXPORT_WAV_BYTES / (1024 * 1024)} MiB.`);
  }
  const decoded = await (dependencies.decodeMp3 ?? decodeMp3InBrowser)(await file.arrayBuffer());
  const wavBytes = encodeCanonicalPcmWav(decoded);
  return ingestProjectAudioWav(
    new File([wavBytes], file.name || "project-audio.mp3", { type: "audio/wav" }),
    dependencies.validateWav ?? validateExportAudioWav,
  );
}
