import { expect, test, type Locator } from "@playwright/test";

export interface RenderedScreenshotMetricsV1 {
  width: number;
  height: number;
  sampledPixels: number;
  opaquePixels: number;
  colorBuckets: number;
  minimumLuminance: number;
  maximumLuminance: number;
}

/**
 * Pixel-level rendered-state assertion without a platform-specific golden.
 * Chromium decodes the actual locator screenshot, samples a bounded canvas,
 * and proves that the result has useful dimensions, opaque pixels, multiple
 * quantized colors, and visible luminance range. Structural assertions remain
 * in the calling test; this guard catches blank/transparent render failures.
 */
export async function expectRenderedScreenshotState(
  locator: Locator,
  attachmentName: string,
  options: { minimumWidth?: number; minimumHeight?: number } = {},
): Promise<RenderedScreenshotMetricsV1> {
  const screenshot = await locator.screenshot({
    animations: "disabled",
    caret: "hide",
  });
  const dataUrl = `data:image/png;base64,${screenshot.toString("base64")}`;
  const metrics = await locator.page().evaluate(async (input) => {
    const response = await fetch(input.dataUrl);
    const bitmap = await createImageBitmap(await response.blob());
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const scale = Math.min(1, 512 / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Screenshot QA canvas is unavailable.");
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height).data;
    const colors = new Set<number>();
    let opaquePixels = 0;
    let minimumLuminance = 255;
    let maximumLuminance = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3];
      if (alpha < 16) continue;
      opaquePixels += 1;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const luminance = Math.round(
        red * 0.2126 + green * 0.7152 + blue * 0.0722,
      );
      minimumLuminance = Math.min(minimumLuminance, luminance);
      maximumLuminance = Math.max(maximumLuminance, luminance);
      colors.add((red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4));
    }
    return {
      width: originalWidth,
      height: originalHeight,
      sampledPixels: width * height,
      opaquePixels,
      colorBuckets: colors.size,
      minimumLuminance,
      maximumLuminance,
    };
  }, { dataUrl });

  expect(metrics.width, `${attachmentName} screenshot width`).toBeGreaterThanOrEqual(
    options.minimumWidth ?? 80,
  );
  expect(metrics.height, `${attachmentName} screenshot height`).toBeGreaterThanOrEqual(
    options.minimumHeight ?? 40,
  );
  expect(
    metrics.opaquePixels / Math.max(1, metrics.sampledPixels),
    `${attachmentName} screenshot must not be transparent`,
  ).toBeGreaterThan(0.9);
  expect(
    metrics.colorBuckets,
    `${attachmentName} screenshot must contain rendered visual variation`,
  ).toBeGreaterThanOrEqual(4);
  expect(
    metrics.maximumLuminance - metrics.minimumLuminance,
    `${attachmentName} screenshot must not be a flat blank frame`,
  ).toBeGreaterThanOrEqual(16);

  await test.info().attach(attachmentName, {
    body: screenshot,
    contentType: "image/png",
  });
  return metrics;
}
