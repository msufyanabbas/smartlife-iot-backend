// src/modules/floor-plans/mesh/mesh.builder.ts
//
// Accumulates triangles into per-material groups, ready for an exporter.
//
// Vertices are NOT shared between faces. A shared vertex averages its normal
// across every face using it, rounding off the exact 90° corners that make a
// building look like a building. Buildings want flat shading, so each face gets
// its own three vertices and its own face normal. The cost is ~3× the vertex
// count, which for a floor plan is trivial.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MaterialDefinition {
  name: string;
  /** Linear RGBA, 0–1. */
  color: [number, number, number, number];
  metallic: number;
  roughness: number;
  transparent?: boolean;
}

export interface MeshGroup {
  material: MaterialDefinition;
  positions: number[];
  normals: number[];
  indices: number[];
}

export const FLOOR_PLAN_MATERIALS: Record<string, MaterialDefinition> = {
  wall: { name: 'Wall', color: [0.87, 0.86, 0.83, 1], metallic: 0, roughness: 0.9 },
  floor: { name: 'Floor', color: [0.62, 0.63, 0.66, 1], metallic: 0, roughness: 0.8 },
  column: { name: 'Column', color: [0.55, 0.56, 0.58, 1], metallic: 0.1, roughness: 0.7 },
  door: { name: 'Door', color: [0.55, 0.35, 0.19, 1], metallic: 0, roughness: 0.6 },
  window: {
    name: 'Window',
    color: [0.55, 0.75, 0.85, 0.35],
    metallic: 0,
    roughness: 0.1,
    transparent: true,
  },
  stair: { name: 'Stair', color: [0.7, 0.68, 0.65, 1], metallic: 0, roughness: 0.85 },
  furniture: { name: 'Furniture', color: [0.45, 0.5, 0.55, 1], metallic: 0, roughness: 0.7 },
};

export class MeshBuilder {
  private readonly groups = new Map<string, MeshGroup>();

  private group(key: string): MeshGroup {
    let group = this.groups.get(key);
    if (!group) {
      group = {
        material: FLOOR_PLAN_MATERIALS[key] ?? FLOOR_PLAN_MATERIALS.wall,
        positions: [],
        normals: [],
        indices: [],
      };
      this.groups.set(key, group);
    }
    return group;
  }

  /**
   * Adds one triangle. The normal comes from the winding via the cross product,
   * so callers control facing by vertex order (CCW seen from the front).
   */
  addTriangle(key: string, a: Vec3, b: Vec3, c: Vec3): void {
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const uz = b.z - a.z;
    const vx = c.x - a.x;
    const vy = c.y - a.y;
    const vz = c.z - a.z;

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;

    const length = Math.hypot(nx, ny, nz);
    // A degenerate triangle has no direction. Skip rather than emit NaN
    // normals, which make most glTF viewers render nothing at all.
    if (length < 1e-12) return;

    nx /= length;
    ny /= length;
    nz /= length;

    const group = this.group(key);
    const base = group.positions.length / 3;

    group.positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) group.normals.push(nx, ny, nz);
    group.indices.push(base, base + 1, base + 2);
  }

  addQuad(key: string, a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.addTriangle(key, a, b, c);
    this.addTriangle(key, a, c, d);
  }

  /**
   * Arbitrarily oriented box. `origin` is the centre of the bottom face, `u` the
   * box's own length direction in plan — so a wall segment can be placed along
   * its centreline without the caller doing matrix work.
   */
  addBox(
    key: string,
    origin: Vec3,
    u: { x: number; y: number },
    length: number,
    width: number,
    height: number,
  ): void {
    if (length <= 0 || width <= 0 || height <= 0) return;

    const uLength = Math.hypot(u.x, u.y);
    if (uLength < 1e-12) return;

    const ux = u.x / uLength;
    const uy = u.y / uLength;
    const px = -uy;
    const py = ux;

    const hl = length / 2;
    const hw = width / 2;

    const corner = (l: number, w: number, h: number): Vec3 => ({
      x: origin.x + ux * l + px * w,
      y: origin.y + uy * l + py * w,
      z: origin.z + h,
    });

    const b0 = corner(-hl, -hw, 0);
    const b1 = corner(hl, -hw, 0);
    const b2 = corner(hl, hw, 0);
    const b3 = corner(-hl, hw, 0);
    const t0 = corner(-hl, -hw, height);
    const t1 = corner(hl, -hw, height);
    const t2 = corner(hl, hw, height);
    const t3 = corner(-hl, hw, height);

    // Winding chosen so every face normal points out of the box.
    this.addQuad(key, t0, t1, t2, t3);
    this.addQuad(key, b3, b2, b1, b0);
    this.addQuad(key, b0, b1, t1, t0);
    this.addQuad(key, b2, b3, t3, t2);
    this.addQuad(key, b1, b2, t2, t1);
    this.addQuad(key, b3, b0, t0, t3);
  }

  /** Flat horizontal polygon at height z. */
  addHorizontalPolygon(
    key: string,
    vertices: Array<{ x: number; y: number }>,
    triangles: number[],
    z: number,
    faceUp = true,
  ): void {
    for (let i = 0; i < triangles.length; i += 3) {
      const a = vertices[triangles[i]];
      const b = vertices[triangles[i + 1]];
      const c = vertices[triangles[i + 2]];
      if (!a || !b || !c) continue;

      const va = { x: a.x, y: a.y, z };
      const vb = { x: b.x, y: b.y, z };
      const vc = { x: c.x, y: c.y, z };

      if (faceUp) this.addTriangle(key, va, vb, vc);
      else this.addTriangle(key, va, vc, vb);
    }
  }

  /** Slab with vertical sides, so it reads as a solid rather than two sheets. */
  addExtrudedPolygon(
    key: string,
    vertices: Array<{ x: number; y: number }>,
    triangles: number[],
    baseZ: number,
    thickness: number,
  ): void {
    const topZ = baseZ + thickness;

    this.addHorizontalPolygon(key, vertices, triangles, topZ, true);
    this.addHorizontalPolygon(key, vertices, triangles, baseZ, false);

    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % vertices.length];

      this.addQuad(
        key,
        { x: a.x, y: a.y, z: baseZ },
        { x: b.x, y: b.y, z: baseZ },
        { x: b.x, y: b.y, z: topZ },
        { x: a.x, y: a.y, z: topZ },
      );
    }
  }

  getGroups(): MeshGroup[] {
    return [...this.groups.values()].filter((g) => g.indices.length > 0);
  }

  get triangleCount(): number {
    return this.getGroups().reduce((sum, g) => sum + g.indices.length / 3, 0);
  }

  get vertexCount(): number {
    return this.getGroups().reduce((sum, g) => sum + g.positions.length / 3, 0);
  }

  isEmpty(): boolean {
    return this.triangleCount === 0;
  }
}
