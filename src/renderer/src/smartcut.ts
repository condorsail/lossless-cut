import i18n from 'i18next';

import { getRealVideoStreams, getVideoTimebase } from './util/streams';

import { readKeyframesAroundTime, findNextKeyframe, findKeyframeAtExactTime } from './ffmpeg';
import { FFprobeStream } from '../../../ffprobe';
import { UserFacingError } from '../errors';

const { stat } = window.require('fs-extra');


const mapVideoCodec = (codec: string) => ({ av1: 'libsvtav1' }[codec] ?? codec);

/**
 * Get optimal CRF value for a given encoder
 * CRF = Constant Rate Factor (quality-based encoding)
 * Lower = better quality, higher file size
 */
export function getOptimalCRF(encoder: string): number | undefined {
  // Software encoders
  if (encoder === 'libx264') return 23; // Default for x264, range 0-51, 18-28 typical
  if (encoder === 'libx265') return 28; // Default for x265, range 0-51, 24-32 typical
  if (encoder === 'libsvtav1') return 35; // SVT-AV1, range 0-63

  // NVENC encoders
  if (encoder === 'h264_nvenc') return 23; // CQ mode, range 0-51
  if (encoder === 'hevc_nvenc') return 28; // CQ mode, range 0-51
  if (encoder === 'av1_nvenc') return 30; // CQ mode for AV1

  // VideoToolbox (macOS)
  if (encoder === 'h264_videotoolbox') return undefined; // Uses quality parameter instead
  if (encoder === 'hevc_videotoolbox') return undefined; // Uses quality parameter instead

  // QuickSync
  if (encoder === 'h264_qsv') return 23; // ICQ mode
  if (encoder === 'hevc_qsv') return 28; // ICQ mode
  if (encoder === 'av1_qsv') return 30; // ICQ mode

  // VAAPI - limited CRF support
  if (encoder.includes('vaapi')) return undefined; // VAAPI typically uses bitrate or qp

  // AMF
  if (encoder === 'h264_amf') return 23; // CQP mode
  if (encoder === 'hevc_amf') return 28; // CQP mode
  if (encoder === 'av1_amf') return 30; // CQP mode

  return undefined; // Fallback to bitrate mode
}

/**
 * Get optimal preset for a given encoder
 * Presets control encoding speed vs compression efficiency
 */
export function getOptimalPreset(encoder: string): string | undefined {
  // Software encoders
  if (encoder === 'libx264') return 'medium'; // Options: ultrafast, superfast, veryfast, faster, fast, medium, slow, slower, veryslow
  if (encoder === 'libx265') return 'medium'; // Same as x264
  if (encoder === 'libsvtav1') return '6'; // Range 0-13, lower = slower/better (8 is default)

  // NVENC encoders
  if (encoder.includes('nvenc')) return 'p4'; // p1-p7, p4 is balanced (p7 = slowest/best)

  // VideoToolbox
  if (encoder.includes('videotoolbox')) return undefined; // No preset equivalent

  // QuickSync
  if (encoder.includes('qsv')) return 'medium'; // Options: veryfast, faster, fast, medium, slow, slower, veryslow

  // VAAPI
  if (encoder.includes('vaapi')) return undefined; // Limited preset support

  // AMF
  if (encoder.includes('amf')) return 'balanced'; // Options: speed, balanced, quality

  return undefined;
}

/**
 * Check if encoder supports CRF/CQ mode
 */
export function supportsCRF(encoder: string): boolean {
  return getOptimalCRF(encoder) !== undefined;
}

/**
 * Get encoder-specific quality arguments for FFmpeg
 */
export function getEncoderQualityArgs(encoder: string, outputIndex: number, customCRF?: number, customPreset?: string): string[] {
  const args: string[] = [];

  const crf = customCRF ?? getOptimalCRF(encoder);
  const preset = customPreset ?? getOptimalPreset(encoder);

  // Add CRF/CQ parameter
  if (crf !== undefined) {
    if (encoder.includes('nvenc')) {
      args.push(`-cq:${outputIndex}`, String(crf));
    } else if (encoder.includes('qsv')) {
      args.push(`-global_quality:${outputIndex}`, String(crf));
    } else if (encoder.includes('amf')) {
      args.push(`-qp_i:${outputIndex}`, String(crf), `-qp_p:${outputIndex}`, String(crf));
    } else {
      // Software encoders (libx264, libx265, libsvtav1)
      args.push(`-crf:${outputIndex}`, String(crf));
    }
  }

  // Add preset parameter
  if (preset !== undefined) {
    args.push(`-preset:${outputIndex}`, preset);
  }

  // VideoToolbox quality parameter (0.0-1.0, higher = better)
  if (encoder.includes('videotoolbox')) {
    args.push(`-q:${outputIndex}`, '65'); // 0-100 scale, 65 is good quality
  }

  return args;
}

export async function needsSmartCut({ path, desiredCutFrom, videoStream }: {
  path: string,
  desiredCutFrom: number,
  videoStream: Pick<FFprobeStream, 'index'>,
}) {
  const readKeyframes = async (window: number) => readKeyframesAroundTime({ filePath: path, streamIndex: videoStream.index, aroundTime: desiredCutFrom, window });

  let keyframes = await readKeyframes(10);

  const keyframeAtExactTime = findKeyframeAtExactTime(keyframes, desiredCutFrom);
  if (keyframeAtExactTime) {
    console.log('Start cut is already on exact keyframe', keyframeAtExactTime.time);

    return {
      losslessCutFrom: keyframeAtExactTime.time,
      segmentNeedsSmartCut: false,
    };
  }

  let nextKeyframe = findNextKeyframe(keyframes, desiredCutFrom);

  if (nextKeyframe == null) {
    // try again with a larger window
    keyframes = await readKeyframes(60);
    nextKeyframe = findNextKeyframe(keyframes, desiredCutFrom);
  }
  if (nextKeyframe == null) throw new UserFacingError(i18n.t('Cannot find any keyframe after the desired start cut point'));

  console.log('Smart cut from keyframe', { keyframe: nextKeyframe.time, desiredCutFrom });

  return {
    losslessCutFrom: nextKeyframe.time,
    segmentNeedsSmartCut: true,
  };
}

// eslint-disable-next-line import/prefer-default-export
export async function getCodecParams({ path, fileDuration, streams }: {
  path: string,
  fileDuration: number | undefined,
  streams: Pick<FFprobeStream, 'time_base' | 'codec_type' | 'disposition' | 'index' | 'bit_rate' | 'codec_name'>[],
}) {
  const videoStreams = getRealVideoStreams(streams);
  if (videoStreams.length > 1) throw new Error('Can only smart cut video with exactly one video stream');

  const [videoStream] = videoStreams;

  if (videoStream == null) throw new Error('Smart cut only works on videos');

  let videoBitrate = parseInt(videoStream.bit_rate!, 10);
  if (Number.isNaN(videoBitrate)) {
    console.warn('Unable to detect input bitrate.');
    const stats = await stat(path);
    if (fileDuration == null) throw new Error('Video duration is unknown, cannot estimate bitrate');
    videoBitrate = (stats.size * 8) / fileDuration;
    console.warn('Estimated bitrate.', videoBitrate / 1e6, 'Mbit/s');
  }

  // to account for inaccuracies and quality loss
  // see discussion https://github.com/mifi/lossless-cut/issues/126#issuecomment-1602266688
  videoBitrate = Math.floor(videoBitrate * 1.2);

  const { codec_name: detectedVideoCodec } = videoStream;
  if (detectedVideoCodec == null) throw new Error('Unable to determine codec for smart cut');

  const videoCodec = mapVideoCodec(detectedVideoCodec);
  console.log({ detectedVideoCodec, videoCodec });

  const timebase = getVideoTimebase(videoStream);
  if (timebase == null) console.warn('Unable to determine timebase', videoStream.time_base);

  // seems like ffmpeg handles this itself well when encoding same source file
  // const videoLevel = parseLevel(videoStream);
  // const videoProfile = parseProfile(videoStream);

  return {
    videoStream,
    videoCodec,
    videoBitrate: Math.floor(videoBitrate),
    videoTimebase: timebase,
  };
}
