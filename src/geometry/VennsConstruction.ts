/**
 * 1:1 port of `constructingVennDiagram/VennsConstruction.java`
 * (the JPanel/PaintSurface pair collapsed into one class that owns the
 * off-screen pixel buffer instead of a Swing component tree).
 *
 * Geometry parity notes (all integer arithmetic mirrors Java's `int` math):
 *   - displacement            = floor(bufferWidth / 8)
 *   - square 1                at (70 + displacement, 80 + displacement),
 *                             size 3*displacement x 3*displacement
 *   - square 2                offset (+displacement, -displacement)
 *   - square 3                offset (+displacement, +2*displacement)
 *   - N >= 4 seeds the inductive curve from the bottom band of square 3:
 *       [(x, y), (x, y - 2*length/3 - 4), (x + width, y - 2*length/3 - 4),
 *        (x + width, y)]  (after y += 2*length/3 + 4)
 *   - each induction step halves the displacement (integer division) and
 *     cycles stroke colors red -> dark green -> blue -> purple (#912C8A)
 *   - the 4-direction state machine ('s','e','u','d','l','r') traces the
 *     previous curve and collects the next boundary path in `path2`
 *     merged with `path3` reversed.
 */

import { Raster, WHITE, BLACK, RED, DARK_GREEN, BLUE, PURPLE, ORANGE } from '../renderer/Raster.ts';
import { FloodFill } from '../renderer/FloodFill.ts';
import { drawSmooth } from './SmoothConstruction.ts';
import type { Pt } from './Mapper.ts';

/** Java integer division for non-negative operands. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/**
 * Rendering styles:
 *  - 'classic'  — the exact 1:1 Java geometry (squares + rectilinear curves,
 *                 black/red/green/blue/purple strokes, orange fills).
 *  - 'circular' — true circles for N ≤ 3 and, for N ≥ 4, the smooth arc-band
 *                 construction of John Venn's own figures (see
 *                 `SmoothConstruction.ts`): a cut annulus hugging circle 3,
 *                 then each new set following the previous curve on both
 *                 sides with semicircular U-turn caps. Region binding is
 *                 analytic (circle equations + arc-loop containment); the
 *                 classic mapper remains untouched for the parity mode.
 */
export type GeometryStyle = 'classic' | 'circular';

export const DEFAULT_WIDTH = 1181;
export const DEFAULT_LENGTH = 919;
export const DEFAULT_ZOOM = 50;
export const DEFAULT_ZOOMFACTOR = 20;

/**
 * Label anchor for one set — implements the thesis' §5.2 "Future works"
 * improvement ("labeling that shows to which square or curve the
 * propositional letter corresponds", Figure 5.1).
 * `set` is the 0-based set index: 0..2 are the squares, 3+ are the curves.
 */
export interface LabelAnchor {
  set: number;
  x: number;
  y: number;
  color: number;
  align: 'left' | 'right';
}

export class VennsConstruction {
  /** Java statics: `public static int width = 1181, length = 919, ZOOM = 50, ZOOMFACTOR = 20;` */
  public width = DEFAULT_WIDTH;
  public length = DEFAULT_LENGTH;
  public ZOOM = DEFAULT_ZOOM;
  public ZOOMFACTOR = DEFAULT_ZOOMFACTOR;

  /** Rendering style — 'classic' keeps engine-level 1:1 parity by default. */
  public style: GeometryStyle = 'classic';

  /**
   * Upper bound on buffer pixels (width × length) any zoom-in may reach.
   * Browsers silently blank canvases past their area cap (Chromium: 2^28 px)
   * and every buffer pixel costs 4 bytes in the raster + region map + tiles,
   * so the app sets this to a platform-safe budget. Default Infinity keeps
   * the pure engine (and the parity tests) exactly as the Java original.
   */
  public maxBufferPixels: number = Number.POSITIVE_INFINITY;

  /** True when the last zoom-in attempt was denied by `maxBufferPixels`. */
  public zoomDenied = false;

  /** Java statics: `public static List<Point> path, filling;` */
  public path: Pt[] | null = null;
  public filling: Pt[] | null = null;

  /** Label anchors for the current diagram (thesis §5.2 labeling feature). */
  public labelAnchors: LabelAnchor[] = [];

  /** Analytic per-pixel region→row map for the smooth style (circular, n ≥ 4). */
  public smoothRegionMap: Int32Array | null = null;

  /**
   * Number of fill seeds that landed on a non-white pixel during the current
   * diagram — the thesis §4.1 known bug ("no pixels left between the curves,
   * the program cannot fill some regions"). Reset on every draw().
   */
  public blockedFills = 0;

  /** Java PaintSurface fields. */
  public buffer: Raster;
  private colorSwitch = 0;
  private lastVenn = 3;

  /** Bumped every time the buffer pixels change, so the UI knows to re-blit. */
  public revision = 0;

  constructor() {
    this.buffer = new Raster(this.width, this.length);
    this.colorSwitch = 0;
    this.drawVenn(3); // to show default 3 block diagram
  }

  /** Java: `VennsConstruction.draw(int n)` */
  public draw(n: number): void {
    this.blockedFills = 0;
    this.path = this.drawVenn(n);
    this.revision++;
  }

  /**
   * Java: `PaintSurface.update()` — recreate the buffer and redraw the last
   * diagram. `redraw = false` only rebuilds the (blank) buffer: callers that
   * immediately re-run `loop()` — which draws AND fills — pass false so each
   * zoom step performs a single construction instead of two.
   */
  public update(redraw = true): void {
    this.buffer = new Raster(this.width, this.length);
    this.colorSwitch = 0;
    if (redraw) this.drawVenn(this.lastVenn);
    this.revision++;
  }

  /** Java: `VennsConstruction.fill(Point location)` */
  public fillPoint(location: Pt): void {
    // Thesis §4.1 bug detection: a seed that is not on a white pixel means
    // its region has collapsed (no pixels between the curves at this zoom),
    // so the flood fill cannot reveal it.
    if (
      location.x >= 0 &&
      location.y >= 0 &&
      location.x < this.buffer.width &&
      location.y < this.buffer.height &&
      this.buffer.getPixel(location.x, location.y) !== WHITE
    ) {
      this.blockedFills++;
    }
    this.buffer = FloodFill.fillRegion(location.x, location.y, this.buffer, this.fillColor());
    this.revision++;
  }

  /** Fill color for true regions — orange in both styles, like the original. */
  public fillColor(): number {
    return ORANGE;
  }

  /** Java: `VennsConstruction.fill(List<Point> arg)` */
  public fillPoints(arg: Pt[] | null, onProgress?: (done: number, total: number) => void): void {
    if (arg === null) return;
    this.filling = arg;
    for (let i = 0; i < arg.length; i++) {
      this.fillPoint(arg[i]);
      if (onProgress !== undefined && ((i & 31) === 31 || i === arg.length - 1)) {
        onProgress(i + 1, arg.length);
      }
    }
  }

  /** Whether one more zoom-in step stays inside the `maxBufferPixels` budget. */
  public canZoomIn(): boolean {
    return (this.width + this.ZOOM) * (this.length + this.ZOOM) <= this.maxBufferPixels;
  }

  /** Java: `zoomin()` — plus the browser-safe buffer budget guard. */
  public zoomin(redraw = true): void {
    if (!this.canZoomIn()) {
      this.zoomDenied = true;
      return;
    }
    this.zoomDenied = false;
    this.width += this.ZOOM;
    this.length += this.ZOOM;
    this.ZOOM += this.ZOOMFACTOR;
    this.ZOOMFACTOR++;
    this.update(redraw);
  }

  /** Java: `zoomout()` — including the original's guards around the default size. */
  public zoomout(redraw = true): void {
    this.zoomDenied = false;
    if (this.width < DEFAULT_WIDTH && this.length < DEFAULT_LENGTH) {
      this.reset(redraw);
    }
    if (this.width > DEFAULT_WIDTH && this.length > DEFAULT_LENGTH) {
      if (this.width - this.ZOOM < DEFAULT_WIDTH || this.length - this.ZOOM < DEFAULT_LENGTH) {
        this.reset(redraw);
      } else {
        this.width -= this.ZOOM;
        this.length -= this.ZOOM;
        this.ZOOM -= this.ZOOMFACTOR;
        this.ZOOMFACTOR--;
        this.update(redraw);
      }
    }
  }

  /** Java: `reset()` — return to the default zoom position. */
  public reset(redraw = true): void {
    this.zoomDenied = false;
    this.width = DEFAULT_WIDTH;
    this.length = DEFAULT_LENGTH;
    this.ZOOM = DEFAULT_ZOOM;
    this.ZOOMFACTOR = DEFAULT_ZOOMFACTOR;
    this.update(redraw);
  }

  /**
   * Java: `PaintSurface.drawVenn(int n)` — the main algorithm.
   * Returns the seed/boundary point list (`retVal` in the original).
   */
  public drawVenn(n: number): Pt[] | null {
    this.lastVenn = n;
    let retVal: Pt[] | null = null;
    this.labelAnchors = [];
    if (n < 1) {
      // Java returns before clearing; the port clears to white so a stale
      // diagram is not left behind for 0-proposition statements.
      this.buffer.fillAll(WHITE);
      return null;
    }
    this.colorSwitch = 0;
    const g2d = this.buffer;
    // paint the surface white so that previous drawing is removed
    g2d.fillAll(WHITE);

    // drawing variables
    let x: number, y: number, width: number, length: number, displacement: number;
    displacement = idiv(this.width, 8);

    // Circular style: true circles for n <= 3 (the classic Venn look) and the
    // smooth arc-band construction for n >= 4 (Venn's own figures).
    this.smoothRegionMap = null;
    if (this.style === 'circular') {
      if (n <= 3) {
        return this.drawCircles(n, displacement);
      }
      const smooth = drawSmooth(g2d, n, displacement);
      this.labelAnchors = smooth.labelAnchors;
      this.smoothRegionMap = smooth.regionMap;
      return smooth.seedsInValuesOrder;
    }

    // x, y coordinates for the first square after which we will use them to draw next 2
    x = 70 + displacement;
    y = 80 + displacement;
    width = displacement * 3;
    length = displacement * 3;

    // start drawing first 3 squares as per value of n 1,2,3
    g2d.markGroup(0, BLACK);
    g2d.drawRect(x, y, width, length, BLACK);
    // set 1 = the square on the left: label inside its bottom-left corner
    this.labelAnchors.push({ set: 0, x: x + 14, y: y + length - 14, color: BLACK, align: 'left' });
    if (n === 1) {
      retVal = [];
      retVal.push({ x: x + displacement, y: y + displacement });
      retVal.push({ x: 1, y: 1 });
    }
    x += displacement;
    y -= displacement;

    // always draw when n is greater or equal to 2
    if (n >= 2) {
      g2d.markGroup(1, BLACK);
      g2d.drawRect(x, y, width, length, BLACK);
      // set 2 = the square on the top: label inside its top-right corner
      this.labelAnchors.push({ set: 1, x: x + width - 14, y: y + 26, color: BLACK, align: 'right' });
    }

    // 2 squares
    if (n === 2) {
      retVal = [];
      retVal.push({ x: x + displacement, y: y + displacement + 1 });
      retVal.push({ x: x - idiv(displacement, 2), y: y + Math.trunc(displacement * 2.5) });
      retVal.push({ x: x + Math.trunc(displacement * 2.5), y: y + idiv(displacement, 2) });
      retVal.push({ x: 1, y: 1 });
    }
    x += displacement;
    y += displacement * 2;

    // always draw when n is greater or equal to 3
    if (n >= 3) {
      g2d.markGroup(2, BLACK);
      g2d.drawRect(x, y, width, length, BLACK);
      // set 3 = the square on the bottom: label inside its bottom-right corner
      this.labelAnchors.push({ set: 2, x: x + width - 14, y: y + length - 14, color: BLACK, align: 'right' });
    }

    // 3 squares
    if (n === 3) {
      retVal = [];
      retVal.push({ x: x + 1, y: y + 1 });
      retVal.push({ x: x - 1, y: y - 1 });
      retVal.push({ x: x + 1, y: y + 1 + displacement });
      retVal.push({ x: x - 1, y: y + 1 + displacement });
      retVal.push({ x: x + 1 + displacement, y: y + 1 });
      retVal.push({ x: x + 1 + displacement, y: y - 1 });
      retVal.push({ x: x + 1 + displacement, y: y + 1 + displacement });
      retVal.push({ x: 1, y: 1 });
    }
    y += idiv(length * 2, 3) + 4;

    // if value of n is 4 or greater then we start to draw advanced internal lines
    if (n >= 4) {
      // dynamic lists to keep track of path and update them as needed
      let path: Pt[] = [];
      let path2: Pt[] = [];
      let path3: Pt[] = [];
      // other variables and initializers
      let direction = 'x';
      let lastDirection = 'x';
      let nextDirection = 'x';

      path.push({ x: x, y: y });
      path.push({ x: x, y: y - idiv(length * 2, 3) - 4 });
      path.push({ x: x + width, y: y - idiv(length * 2, 3) - 4 });
      path.push({ x: x + width, y: y });

      let x1: number, x2: number, x3: number, y1: number, y2: number, y3: number;
      // the main loop that draws each line scheme based on the previous one path
      for (let I = 4; I <= n; I++) {
        // each time displacement between lines is decreased by half
        displacement = idiv(displacement, 2);
        // for each line scheme change the color accordingly
        const color = this.getColor();
        g2d.markGroup(I - 1, color);
        // internal loop to draw one scheme of lines based on path provided as points of plane (x,y)
        for (let i = 0; i < path.length - 1; i++) {
          // get the point1 and point1+1
          x1 = path[i].x;
          y1 = path[i].y;
          x2 = path[i + 1].x;
          y2 = path[i + 1].y;
          // if point1+2 exists, get that as well
          if (i !== path.length - 2) {
            x3 = path[i + 2].x;
            y3 = path[i + 2].y;
          } else {
            x3 = y3 = 0;
          }

          // draw starting and ending lines
          if (i === 0) {
            g2d.drawLine(x1 - displacement, y1 - displacement, x1 + displacement, y1 - displacement, color);
            // set I = this curve: label just left of its starting cap, in the curve's color
            this.labelAnchors.push({
              set: I - 1,
              x: x1 - displacement - 6,
              y: y1 - displacement + 5,
              color,
              align: 'right',
            });
          } else if (i === path.length - 2) {
            g2d.drawLine(x2 - displacement, y2 - displacement, x2 + displacement, y2 - displacement, color);
          }
          // determine direction
          /*
           * 1. start direction up -> s 2. end direction down -> e
           * 3. simple up -> u 4. simple down -> d
           * 5. simple left -> l 6. simple right -> r
           */
          lastDirection = direction;
          direction = 'x';
          if (i === 0) {
            direction = 's';
          } else if (i === path.length - 2) {
            direction = 'e';
          } else if (x1 === x2 && y1 > y2) {
            direction = 'u';
          } else if (x1 === x2 && y1 < y2) {
            direction = 'd';
          } else if (x1 > x2 && y1 === y2) {
            direction = 'l';
          } else if (x1 < x2 && y1 === y2) {
            direction = 'r';
          }
          // same principle to determine the next direction if there is any
          if (i !== 0 && i !== path.length - 2) {
            if (x2 === x3 && y2 > y3) {
              nextDirection = 'u';
            } else if (x2 === x3 && y2 < y3) {
              nextDirection = 'd';
            } else if (x2 > x3 && y2 === y3) {
              nextDirection = 'l';
            } else if (x2 < x3 && y2 === y3) {
              nextDirection = 'r';
            }
          }
          // based on the direction we draw the lines and move forward
          switch (direction) {
            case 's':
              // since we always start from left and move upwards so lines will be like this
              g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);
              g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 + displacement, color);

              path2.push({ x: x1 - displacement, y: y1 - displacement });
              path3.push({ x: x1 + displacement, y: y1 - displacement });
              break;
            case 'e':
              // since we always end to left and move downwards lastly so lines will be like this
              if (I === 4) {
                g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);
                g2d.drawLine(x1 - displacement, y1 + displacement, x2 - displacement, y2 - displacement, color);

                path2.push({ x: x1 + displacement, y: y1 - displacement });
                path3.push({ x: x1 - displacement, y: y1 + displacement });

                path2.push({ x: x2 + displacement, y: y2 - displacement });
                path3.push({ x: x2 - displacement, y: y2 - displacement });
              } else {
                g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);
                g2d.drawLine(x1 + displacement, y1 + displacement, x2 + displacement, y2 - displacement, color);

                path2.push({ x: x1 + displacement, y: y1 + displacement });
                path3.push({ x: x1 - displacement, y: y1 - displacement });

                path2.push({ x: x2 + displacement, y: y2 - displacement });
                path3.push({ x: x2 - displacement, y: y2 - displacement });
              }
              break;
            // the drawing pattern when we are to draw upwards
            case 'u':
              if (lastDirection === 'l') {
                if (nextDirection === 'l') {
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 - displacement, y2 + displacement, color);
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 + displacement });
                  path3.push({ x: x1 + displacement, y: y1 - displacement });
                } else {
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 - displacement, y2 - displacement, color);
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 + displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 + displacement });
                  path3.push({ x: x1 + displacement, y: y1 - displacement });
                }
              } else {
                if (nextDirection === 'l') {
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 + displacement, color);
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 + displacement, y2 - displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 - displacement });
                  path3.push({ x: x1 + displacement, y: y1 + displacement });
                } else {
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 - displacement });
                  path3.push({ x: x1 + displacement, y: y1 + displacement });
                }
              }
              break;
            case 'd':
              // left starts from right to left
              if (lastDirection === 'r') {
                if (nextDirection === 'r') {
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 - displacement, y2 + displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 - displacement });
                  path3.push({ x: x1 - displacement, y: y1 + displacement });
                } else {
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 + displacement, y2 + displacement, color);
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 - displacement, y2 - displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 - displacement });
                  path3.push({ x: x1 - displacement, y: y1 + displacement });
                }
              } else {
                if (nextDirection === 'l') {
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 + displacement });
                  path3.push({ x: x1 - displacement, y: y1 - displacement });
                } else {
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 + displacement, y2 - displacement, color);
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 - displacement, y2 + displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 + displacement });
                  path3.push({ x: x1 - displacement, y: y1 - displacement });
                }
              }
              break;
            case 'l':
              // left starts from right to left
              if (lastDirection === 'u' || lastDirection === 'x') {
                if (nextDirection === 'd') {
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 + displacement });
                  path3.push({ x: x1 + displacement, y: y1 - displacement });
                } else {
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 - displacement });
                  path3.push({ x: x1 - displacement, y: y1 + displacement });
                }
              } else {
                if (nextDirection === 'd') {
                  // for last time it was to down
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 - displacement, y2 + displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 - displacement });
                  path3.push({ x: x1 + displacement, y: y1 + displacement });
                } else {
                  g2d.drawLine(x1 - displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);
                  g2d.drawLine(x1 + displacement, y1 + displacement, x2 - displacement, y2 + displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 + displacement });
                  path3.push({ x: x1 - displacement, y: y1 - displacement });
                }
              }
              break;
            case 'r':
              // from left to right
              if (lastDirection === 'u' || lastDirection === 'x' || lastDirection === 's') {
                g2d.drawLine(x1 - displacement, y1 - displacement, x2 + displacement, y2 - displacement, color);
                g2d.drawLine(x1 + displacement, y1 + displacement, x2 - displacement, y2 + displacement, color);

                path2.push({ x: x1 - displacement, y: y1 - displacement });
                path3.push({ x: x1 + displacement, y: y1 + displacement });
              } else {
                if (nextDirection === 'u') {
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);

                  path2.push({ x: x1 + displacement, y: y1 - displacement });
                  path3.push({ x: x1 - displacement, y: y1 + displacement });
                } else {
                  g2d.drawLine(x1 - displacement, y1 + displacement, x2 + displacement, y2 + displacement, color);
                  g2d.drawLine(x1 + displacement, y1 - displacement, x2 - displacement, y2 - displacement, color);

                  path2.push({ x: x1 - displacement, y: y1 + displacement });
                  path3.push({ x: x1 + displacement, y: y1 - displacement });
                }
              }
              break;
            // handle and show error if we encounter any misleading values (corrupt)
            default:
              console.log('Wrong direction detected');
              console.log('x1 ' + x1 + ' x2 ' + x2 + ' y1 ' + y1 + ' y2 ' + y2);
              break;
          }
        }
        // with each draw of line we save next path in 2 lists;
        // after all path is saved in both lists then we combine and make next path if there is need to
        if (I <= n) {
          path = [];
          for (let j = 0; j < path2.length; j++) {
            path.push(path2[j]);
          }
          for (let j = path3.length - 1; j >= 0; j--) {
            path.push(path3[j]);
          }
          path2 = [];
          path3 = [];
        }
        if (retVal === null) {
          retVal = [];
        }
        retVal.length = 0;

        for (let a = 0; a < path.length; a++) {
          retVal.push(path[a]);
        }
      }
    }

    return retVal;
  }

  /**
   * Circular style, N ≤ 3: true circles — the classic Venn look — with
   * region seed points in the same `values` order the square layout used
   * (index 0 = all-true region … last = the (1,1) universe seed).
   */
  private drawCircles(n: number, displacement: number): Pt[] {
    const g2d = this.buffer;
    const cx = 70 + Math.round(3.5 * displacement);
    const cy = 80 + 3 * displacement;
    const retVal: Pt[] = [];

    if (n === 1) {
      const r = 2 * displacement;
      g2d.markGroup(0, BLACK);
      g2d.drawCircle(cx, cy, r, BLACK);
      this.labelAnchors.push({
        set: 0,
        x: cx - Math.round(r * 0.45),
        y: cy - Math.round(r * 0.45),
        color: BLACK,
        align: 'left',
      });
      retVal.push({ x: cx, y: cy });
      retVal.push({ x: 1, y: 1 });
      return retVal;
    }

    if (n === 2) {
      const r = Math.round(1.7 * displacement);
      const off = Math.round(0.85 * displacement);
      const c1: Pt = { x: cx - off, y: cy };
      const c2: Pt = { x: cx + off, y: cy };
      g2d.markGroup(0, BLACK);
      g2d.drawCircle(c1.x, c1.y, r, BLACK);
      g2d.markGroup(1, BLACK);
      g2d.drawCircle(c2.x, c2.y, r, BLACK);
      this.labelAnchors.push({
        set: 0,
        x: c1.x - Math.round(r * 0.62),
        y: c1.y - Math.round(r * 0.45),
        color: BLACK,
        align: 'left',
      });
      this.labelAnchors.push({
        set: 1,
        x: c2.x + Math.round(r * 0.62),
        y: c2.y - Math.round(r * 0.45),
        color: BLACK,
        align: 'right',
      });
      // values order: [A∧B, A only, B only, universe]
      retVal.push({ x: cx, y: cy });
      retVal.push({ x: c1.x - Math.round(r * 0.5), y: cy });
      retVal.push({ x: c2.x + Math.round(r * 0.5), y: cy });
      retVal.push({ x: 1, y: 1 });
      return retVal;
    }

    // n === 3 — the trio arranged like the reference figure:
    // A on the left, B on the top-right, C on the bottom-right.
    const r = Math.round(1.7 * displacement);
    const triangleRadius = Math.round(0.981 * displacement); // side ≈ r
    const vertex = (angle: number): Pt => ({
      x: cx + Math.round(triangleRadius * Math.cos(angle)),
      y: cy + Math.round(triangleRadius * Math.sin(angle)),
    });
    const c1: Pt = vertex(Math.PI); // A — left
    const c2: Pt = vertex(-Math.PI / 3); // B — top-right
    const c3: Pt = vertex(Math.PI / 3); // C — bottom-right
    const G: Pt = { x: cx, y: cy };
    g2d.markGroup(0, BLACK);
    g2d.drawCircle(c1.x, c1.y, r, BLACK);
    g2d.markGroup(1, BLACK);
    g2d.drawCircle(c2.x, c2.y, r, BLACK);
    g2d.markGroup(2, BLACK);
    g2d.drawCircle(c3.x, c3.y, r, BLACK);

    const outward = (c: Pt, k: number): Pt => {
      const dx = c.x - G.x;
      const dy = c.y - G.y;
      const dist = Math.hypot(dx, dy) || 1;
      return { x: Math.round(c.x + (dx / dist) * k), y: Math.round(c.y + (dy / dist) * k) };
    };
    /** Point inside circles i and j but just outside circle k. */
    const pairSeed = (ci: Pt, cj: Pt, ck: Pt): Pt => {
      const mx = (ci.x + cj.x) / 2;
      const my = (ci.y + cj.y) / 2;
      const dx = mx - ck.x;
      const dy = my - ck.y;
      const dist = Math.hypot(dx, dy) || 1;
      const target = r + Math.max(4, Math.round(0.18 * displacement));
      return { x: Math.round(ck.x + (dx / dist) * target), y: Math.round(ck.y + (dy / dist) * target) };
    };

    const labelDistance = Math.round(r * 0.62);
    this.labelAnchors.push({ set: 0, ...outward(c1, labelDistance), color: BLACK, align: 'right' });
    this.labelAnchors.push({ set: 1, ...outward(c2, labelDistance), color: BLACK, align: 'left' });
    this.labelAnchors.push({ set: 2, ...outward(c3, labelDistance), color: BLACK, align: 'left' });

    // values order: [TTT, TTF, TFT, TFF, FTT, FTF, FFT, universe]
    retVal.push({ x: G.x, y: G.y });
    retVal.push(pairSeed(c1, c2, c3));
    retVal.push(pairSeed(c1, c3, c2));
    retVal.push(outward(c1, Math.round(r * 0.55)));
    retVal.push(pairSeed(c2, c3, c1));
    retVal.push(outward(c2, Math.round(r * 0.55)));
    retVal.push(outward(c3, Math.round(r * 0.55)));
    retVal.push({ x: 1, y: 1 });
    return retVal;
  }

  /** Java: `PaintSurface.getColor()` — red -> dark green -> blue -> purple cycle. */
  private getColor(): number {
    if (this.colorSwitch === 0) {
      this.colorSwitch++;
      return RED;
    } else {
      if (this.colorSwitch === 1) {
        this.colorSwitch++;
        return DARK_GREEN;
      } else if (this.colorSwitch === 2) {
        this.colorSwitch++;
        return BLUE;
      } else if (this.colorSwitch === 3) {
        this.colorSwitch++;
        return PURPLE;
      } else {
        this.colorSwitch = 1;
        return RED;
      }
    }
  }
}
