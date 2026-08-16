/**
 * Port of `constructingVennDiagram/FloodFill.java`.
 *
 * The Java original recurses once per pixel, which overflows the JS call
 * stack on regions of any real size. This implementation is an ITERATIVE
 * queue-based 4-way flood fill operating directly on the 32-bit pixel words
 * of the buffer (`Uint32Array`), producing a final image identical to the
 * recursive version:
 *
 *   - the seed pixel is unconditionally painted (exactly like Java, which
 *     calls `image.setRGB(X, Y, ...)` before inspecting any neighbour);
 *   - the fill then spreads 4-ways through every pixel that is exactly
 *     WHITE (Java: `image.getRGB(...) == Color.WHITE.getRGB()`).
 */

import { Raster, WHITE } from './Raster.ts';

export const FloodFill = {
  /**
   * Java: `public static BufferedImage fillRegion(int X, int Y, BufferedImage img, Color clr)`
   * Returns the same raster for call-site parity.
   */
  fillRegion(X: number, Y: number, raster: Raster, color: number): Raster {
    const { width, height, data } = raster;
    if (X < 0 || Y < 0 || X >= width || Y >= height) {
      return raster; // out-of-bounds seed: nothing to do (Java would throw)
    }

    // Java sets the seed pixel first, whatever its color.
    data[Y * width + X] = color;

    // Iterative 4-way spread through white pixels. Each white pixel is
    // colored *when enqueued* so it is never enqueued twice.
    const stack: number[] = [Y * width + X];
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;

      if (x + 1 < width && data[index + 1] === WHITE) {
        data[index + 1] = color;
        stack.push(index + 1);
      }
      if (y + 1 < height && data[index + width] === WHITE) {
        data[index + width] = color;
        stack.push(index + width);
      }
      if (x - 1 >= 0 && data[index - 1] === WHITE) {
        data[index - 1] = color;
        stack.push(index - 1);
      }
      if (y - 1 >= 0 && data[index - width] === WHITE) {
        data[index - width] = color;
        stack.push(index - width);
      }
    }
    return raster;
  },
};
