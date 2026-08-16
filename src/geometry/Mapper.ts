/**
 * 1:1 port of `constructingVennDiagram/Mapper.java`.
 *
 * `MapList` stores pairs of seed points (each pair derived from one boundary
 * point of the Venn curve) as a 2-D list, then `map()` folds the structure
 * log2(M) times — pairing entries taken from the `front` and `end` pointers —
 * and finally flattens it into the ordered list of seed coordinates.
 *
 *   input  -> [{d,b},{a,c}]
 *   output -> [a,b,c,d]
 */

export interface Pt {
  x: number;
  y: number;
}

/** Java: `Mapper.mapList.data` — two points derived from the same source point. */
interface Data {
  a: Pt;
  b: Pt;
}

export class MapList {
  /** Java: `List<List<data>> mainList` */
  private mainList: Data[][];

  constructor() {
    this.mainList = [];
  }

  /** Java: `public void add(Point a, Point b)` */
  public add(a: Pt, b: Pt): void {
    const node: Data[] = [];
    const d: Data = { a, b };
    node.push(d);
    this.mainList.push(node);
  }

  /** Java: `public List<Point> map()` — arrange data and get output. */
  public map(): Pt[] {
    const n = this.mainList.length; // can be 2, 4, 8, 16 and so on
    let front: number;
    let end: number;
    let folder: Data[][];
    let tempNode: Data[];

    for (let i = Math.floor(Math.log(n) / Math.log(2)); i > 0; i--) {
      folder = [];
      front = 0;
      end = this.mainList.length - 1;
      while (front < end) {
        tempNode = [];
        for (let j = 0; j < this.mainList[end].length; j++) {
          tempNode.push(this.mainList[end][j]);
        }
        for (let j = 0; j < this.mainList[front].length; j++) {
          tempNode.push(this.mainList[front][j]);
        }
        folder.push(tempNode);
        front++;
        end--;
      }
      this.mainList = [];
      for (let j = 0; j < folder.length; j++) {
        this.mainList.push(folder[j]);
      }
      folder.length = 0;
    }

    const ret: Pt[] = [];
    for (let i = 0; i < this.mainList[0].length; i++) {
      ret.push(this.mainList[0][i].a);
      ret.push(this.mainList[0][i].b);
    }
    return ret;
  }
}

/** Namespace parity with `Mapper.java` (`Mapper.mapList` in the original). */
export const Mapper = { MapList };
