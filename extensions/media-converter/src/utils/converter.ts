import path from "path";
import fs from "fs";
import os from "os";
import { findFFmpegPath } from "./ffmpeg";
import { execPromise } from "./exec";
import { convertImageWithSharp, buildSharpCommandString } from "./image-converter";
import {
  AllOutputExtension,
  OutputImageExtension,
  OutputAudioExtension,
  OutputVideoExtension,
  QualitySettings,
  ImageQuality,
  AudioQuality,
  VideoQuality,
  getMediaType,
  Percentage,
} from "../types/media";

function convertQualityToCrf(qualityPercentage: Percentage): number {
  // Map 100% quality to CRF 0, and 0% quality to CRF 51
  // Using a linear mapping for simplicity
  return Math.round(51 - (qualityPercentage / 100) * 51);
}

function getUniqueOutputPath(filePath: string, extension: string): string {
  const outputFilePath = filePath.replace(path.extname(filePath), extension);
  let finalOutputPath = outputFilePath;
  let counter = 1;

  while (fs.existsSync(finalOutputPath)) {
    const fileName = path.basename(outputFilePath, extension);
    const dirName = path.dirname(outputFilePath);
    finalOutputPath = path.join(dirName, `${fileName}(${counter})${extension}`);
    counter++;
  }

  return finalOutputPath;
}

export async function convertMedia<T extends AllOutputExtension>(
  filePath: string,
  outputFormat: T,
  quality: QualitySettings,
  returnCommandString = false,
): Promise<string> {
  const currentMediaType = getMediaType(path.extname(filePath))!;
  switch (currentMediaType) {
    case "image": {
      const currentOutputFormat = outputFormat as OutputImageExtension;
      const imageQuality = quality as ImageQuality;
      const finalOutputPath = getUniqueOutputPath(filePath, currentOutputFormat);

      if (returnCommandString) {
        return buildSharpCommandString(filePath, currentOutputFormat, imageQuality, finalOutputPath);
      }

      try {
        await convertImageWithSharp(filePath, currentOutputFormat, imageQuality, finalOutputPath);
        return finalOutputPath;
      } catch (error) {
        console.error(`Error converting ${filePath} to ${currentOutputFormat}:`, error);
        throw error;
      }
    }

    case "audio": {
      const currentOutputFormat = outputFormat as OutputAudioExtension;
      const audioQuality = quality as AudioQuality;
      const finalOutputPath = getUniqueOutputPath(filePath, currentOutputFormat);

      const ffmpegPathAudio = await findFFmpegPath();
      if (!ffmpegPathAudio) {
        throw new Error("FFmpeg is not installed or configured. Please install FFmpeg to convert audio files.");
      }
      let ffmpegCmd = `"${ffmpegPathAudio.path}" -i "${filePath}"`;

      switch (currentOutputFormat) {
        case ".mp3": {
          const mp3Settings = audioQuality[".mp3"];
          ffmpegCmd += ` -c:a libmp3lame`;
          if (mp3Settings.vbr) {
            ffmpegCmd += ` -q:a ${Math.round((320 - Number(mp3Settings.bitrate)) / 40)}`; // Convert bitrate to VBR quality
          } else {
            ffmpegCmd += ` -b:a ${mp3Settings.bitrate}k`;
          }
          break;
        }
        case ".aac": {
          const aacSettings = audioQuality[".aac"];
          ffmpegCmd += ` -c:a aac -b:a ${aacSettings.bitrate}k`;
          if (aacSettings.profile) {
            ffmpegCmd += ` -profile:a ${aacSettings.profile}`;
          }
          break;
        }
        case ".m4a": {
          const m4aSettings = audioQuality[".m4a"];
          ffmpegCmd += ` -c:a aac -b:a ${m4aSettings.bitrate}k`;
          if (m4aSettings.profile) {
            ffmpegCmd += ` -profile:a ${m4aSettings.profile}`;
          }
          break;
        }
        case ".wav": {
          const wavSettings = audioQuality[".wav"];
          ffmpegCmd += ` -c:a pcm_s${wavSettings.bitDepth}le -ar ${wavSettings.sampleRate}`;
          break;
        }
        case ".flac": {
          const flacSettings = audioQuality[".flac"];
          ffmpegCmd += ` -c:a flac -compression_level ${flacSettings.compressionLevel} -ar ${flacSettings.sampleRate}`;
          if (flacSettings.bitDepth === "24") {
            ffmpegCmd += ` -sample_fmt s32`;
          }
          break;
        }
        default:
          throw new Error(`Unknown audio output format: ${currentOutputFormat}`);
      }

      ffmpegCmd += ` -y "${finalOutputPath}"`;
      if (returnCommandString) {
        return ffmpegCmd;
      }
      console.log(`Executing FFmpeg audio command: ${ffmpegCmd}`);
      await execPromise(ffmpegCmd);
      return finalOutputPath;
    }

    case "video": {
      const currentOutputFormat = outputFormat as OutputVideoExtension;
      const videoQuality = quality as VideoQuality;

      const ffmpegPathVideo = await findFFmpegPath();
      if (!ffmpegPathVideo) {
        throw new Error("FFmpeg is not installed or configured. Please install FFmpeg to convert video files.");
      }
      let ffmpegCmd = `"${ffmpegPathVideo.path}" -i "${filePath}"`;

      // Add format-specific codec and settings
      switch (currentOutputFormat) {
        case ".mp4": {
          const mp4Quality = videoQuality[".mp4"];
          ffmpegCmd += ` -vcodec h264 -acodec aac -preset ${mp4Quality.preset}`;
          break;
        }
        case ".avi": {
          ffmpegCmd += ` -vcodec libxvid -acodec mp3`;
          break;
        }
        case ".mov": {
          const movQuality = videoQuality[".mov"];
          const proresProfiles = {
            proxy: "0",
            lt: "1",
            standard: "2",
            hq: "3",
            "4444": "4",
            "4444xq": "5",
          };
          ffmpegCmd += ` -vcodec prores -profile:v ${proresProfiles[movQuality.variant]} -acodec pcm_s16le`;
          break;
        }
        case ".mkv": {
          const mkvQuality = videoQuality[".mkv"];
          ffmpegCmd += ` -vcodec libx265 -acodec aac -preset ${mkvQuality.preset}`;
          break;
        }
        case ".mpg": {
          ffmpegCmd += ` -vcodec mpeg2video -acodec mp3`;
          break;
        }
        case ".webm": {
          const webmQuality = videoQuality[".webm"];
          ffmpegCmd += ` -vcodec libvpx-vp9 -acodec libopus -quality ${webmQuality.quality}`;
          break;
        }
        default:
          throw new Error(`Unknown video output format: ${currentOutputFormat}`);
      }

      // Force common pixel format for compatibility, except for .mov which may use higher bit depths
      if (currentOutputFormat !== ".mov") {
        ffmpegCmd += ` -pix_fmt yuv420p`;
      }

      // Handle encoding mode (unified for all formats except .mov)
      const finalOutputPath = getUniqueOutputPath(filePath, currentOutputFormat);
      let logFilePrefix: string | null = null;

      if (currentOutputFormat !== ".mov") {
        const qualitySettings = videoQuality[currentOutputFormat];

        if ("encodingMode" in qualitySettings) {
          if (qualitySettings.encodingMode === "crf") {
            ffmpegCmd += ` -crf ${convertQualityToCrf(qualitySettings.crf)}`;
          } else {
            // VBR or VBR 2-pass
            ffmpegCmd += ` -b:v ${qualitySettings.bitrate}k`;

            if ("maxBitrate" in qualitySettings && qualitySettings.maxBitrate) {
              ffmpegCmd += ` -maxrate ${qualitySettings.maxBitrate}k -bufsize ${Number(qualitySettings.maxBitrate) * 2}k`;
            }

            if (qualitySettings.encodingMode === "vbr-2-pass") {
              if (returnCommandString) {
                // For command string, include both passes
                logFilePrefix = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}`);
                const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
                const firstPassCmd = ffmpegCmd + ` -pass 1 -passlogfile "${logFilePrefix}" -f null ${nullDevice}`;
                const secondPassCmd = ffmpegCmd + ` -pass 2 -passlogfile "${logFilePrefix}" -y "${finalOutputPath}"`;
                return `${firstPassCmd}\n${secondPassCmd}`;
              } else {
                // First pass - need to specify log file prefix for 2-pass encoding
                logFilePrefix = path.join(os.tmpdir(), `ffmpeg2pass_${Date.now()}`);
                const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
                const firstPassCmd = ffmpegCmd + ` -pass 1 -passlogfile "${logFilePrefix}" -f null ${nullDevice}`;
                try {
                  await execPromise(firstPassCmd);
                } catch (error) {
                  throw new Error(`First pass encoding failed: ${error}`);
                }
                // Second pass will be executed below
                ffmpegCmd += ` -pass 2 -passlogfile "${logFilePrefix}"`;
              }
            }
          }
        }
      }

      try {
        ffmpegCmd += ` -y "${finalOutputPath}"`;
        if (returnCommandString) {
          return ffmpegCmd;
        }
        console.log(`Executing FFmpeg video command: ${ffmpegCmd}`);
        await execPromise(ffmpegCmd);
        return finalOutputPath;
      } finally {
        // Clean up 2-pass log files if they exist
        if (logFilePrefix) {
          try {
            // Clean up all possible FFmpeg 2-pass log files
            const logFiles = [
              `${logFilePrefix}-0.log`,
              `${logFilePrefix}-0.log.mbtree`,
              `${logFilePrefix}-0.log.temp`,
              `${logFilePrefix}-1.log`,
              `${logFilePrefix}-1.log.mbtree`,
              `${logFilePrefix}-1.log.temp`,
            ];

            for (const logFile of logFiles) {
              if (fs.existsSync(logFile)) {
                try {
                  fs.unlinkSync(logFile);
                } catch (fileError) {
                  console.warn(`Failed to clean up log file ${logFile}:`, fileError);
                }
              }
            }
          } catch (error) {
            console.warn("Failed to clean up FFmpeg log files:", error);
          }
        }
      }
    }

    default:
      throw new Error(`Unsupported media type for file: ${filePath}`);
  }
}
