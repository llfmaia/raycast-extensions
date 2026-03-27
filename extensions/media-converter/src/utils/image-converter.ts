import path from "path";
import fs from "fs";
import os from "os";
import { execPromise } from "./exec";
import { OutputImageExtension, ImageQuality } from "../types/media";

/**
 * Converts an image file to the specified output format using sharp.
 * HEIC output uses the macOS `sips` utility.
 * HEIC input is pre-processed via `sips` before sharp handles the conversion.
 */
export async function convertImageWithSharp(
  inputPath: string,
  outputFormat: OutputImageExtension,
  quality: ImageQuality,
  outputPath: string,
): Promise<void> {
  const extension = path.extname(inputPath).toLowerCase();

  // HEIC output: use the macOS sips utility (not supported by sharp)
  if (outputFormat === ".heic") {
    const heicQuality = quality[".heic"] as number;
    const sipsCmd = `sips --setProperty format heic --setProperty formatOptions ${heicQuality} "${inputPath}" --out "${outputPath}"`;
    try {
      await execPromise(sipsCmd);
    } catch (error) {
      const errorMessage = String(error);
      if (errorMessage.includes("command not found") || errorMessage.includes("not recognized")) {
        throw new Error(
          "HEIC conversion failed: 'sips' command not found. " +
            "Converting to HEIC format is only available on macOS, " +
            "as it requires the built-in SIPS utility with proper HEIC support " +
            "(libheif, libde265, and x265 dependencies).",
        );
      }
      throw new Error(
        "HEIC conversion failed: SIPS command found but conversion unsuccessful. " +
          "This may indicate that your SIPS installation lacks proper HEIC support. " +
          "Converting to HEIC format typically requires macOS with built-in SIPS that includes " +
          "libheif, libde265, and x265 dependencies. Error details: " +
          String(error),
      );
    }
    return;
  }

  let processedInputPath = inputPath;
  let tempHeicFile: string | null = null;

  try {
    // HEIC input: pre-process to PNG via sips so sharp can read it
    if (extension === ".heic") {
      try {
        const tempFileName = `${path.basename(inputPath, ".heic")}_temp_${Date.now()}.png`;
        tempHeicFile = path.join(os.tmpdir(), tempFileName);
        await execPromise(`sips --setProperty format png "${inputPath}" --out "${tempHeicFile}"`);
        processedInputPath = tempHeicFile;
      } catch (error) {
        if (tempHeicFile && fs.existsSync(tempHeicFile)) {
          fs.unlinkSync(tempHeicFile);
        }
        throw new Error(`Failed to preprocess HEIC file: ${String(error)}`);
      }
    }

    // Dynamic import so the module is only loaded when actually needed
    const sharp = (await import("sharp")).default;
    const image = sharp(processedInputPath);

    switch (outputFormat) {
      case ".jpg":
        await image.jpeg({ quality: quality[".jpg"] as number }).toFile(outputPath);
        break;
      case ".png":
        if (quality[".png"] === "png-8") {
          await image.png({ palette: true, colors: 256, dither: 1 }).toFile(outputPath);
        } else {
          // png-24: maximum compression, full-color lossless
          await image.png({ compressionLevel: 9 }).toFile(outputPath);
        }
        break;
      case ".webp":
        if (quality[".webp"] === "lossless") {
          await image.webp({ lossless: true }).toFile(outputPath);
        } else {
          await image.webp({ quality: quality[".webp"] as number }).toFile(outputPath);
        }
        break;
      case ".tiff":
        await image.tiff({ compression: quality[".tiff"] as "deflate" | "lzw" }).toFile(outputPath);
        break;
      case ".avif":
        await image.avif({ quality: quality[".avif"] as number }).toFile(outputPath);
        break;
      default:
        throw new Error(`Unsupported image output format: ${outputFormat}`);
    }
  } finally {
    if (tempHeicFile && fs.existsSync(tempHeicFile)) {
      fs.unlinkSync(tempHeicFile);
    }
  }
}

/**
 * Returns a Node.js code snippet (using sharp) that represents the conversion,
 * suitable for copying to clipboard via the "Copy Conversion Command" action.
 * HEIC output returns the equivalent sips shell command instead.
 */
export function buildSharpCommandString(
  inputPath: string,
  outputFormat: OutputImageExtension,
  quality: ImageQuality,
  outputPath: string,
): string {
  const extension = path.extname(inputPath).toLowerCase();

  if (outputFormat === ".heic") {
    return `sips --setProperty format heic --setProperty formatOptions ${quality[".heic"]} "${inputPath}" --out "${outputPath}"`;
  }

  const inputRef = extension === ".heic" ? `/* pre-processed HEIC → PNG via sips */ "${inputPath}"` : `"${inputPath}"`;

  let sharpCall = `sharp(${inputRef})`;

  switch (outputFormat) {
    case ".jpg":
      sharpCall += `\n  .jpeg({ quality: ${quality[".jpg"]} })`;
      break;
    case ".png":
      if (quality[".png"] === "png-8") {
        sharpCall += `\n  .png({ palette: true, colors: 256, dither: 1 })`;
      } else {
        sharpCall += `\n  .png({ compressionLevel: 9 })`;
      }
      break;
    case ".webp":
      if (quality[".webp"] === "lossless") {
        sharpCall += `\n  .webp({ lossless: true })`;
      } else {
        sharpCall += `\n  .webp({ quality: ${quality[".webp"]} })`;
      }
      break;
    case ".tiff":
      sharpCall += `\n  .tiff({ compression: "${quality[".tiff"]}" })`;
      break;
    case ".avif":
      sharpCall += `\n  .avif({ quality: ${quality[".avif"]} })`;
      break;
  }

  sharpCall += `\n  .toFile("${outputPath}");`;
  return sharpCall;
}
