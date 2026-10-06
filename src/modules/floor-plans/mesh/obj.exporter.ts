// src/modules/floor-plans/mesh/obj.exporter.ts
//
// Wavefront OBJ (+ MTL) and binary STL.
//
// OBJ is here because every CAD and BIM tool opens it without argument — Revit,
// SketchUp, Blender — where glTF support is still patchy in the older versions
// people run on site. STL is for engineering interchange and printing.

import type { MeshGroup } from './mesh.builder';
import type { UpAxis } from './gltf.exporter';

export interface ObjExportOptions {
  upAxis?: UpAxis;
  baseName?: string;
}

export class ObjExporter {
  /**
   * OBJ plus its companion MTL. Returned together because an OBJ referencing a
   * missing MTL loads as untextured grey, and it is easy to write one and forget
   * the other.
   */
  static toOBJ(
    groups: MeshGroup[],
    options: ObjExportOptions = {},
  ): { obj: Buffer; mtl: Buffer } {
    const upAxis = options.upAxis ?? 'y-up';
    const baseName = options.baseName ?? 'floor-plan';

    const objLines: string[] = [
      '# Smart Life IoT Platform — generated from floor plan geometry',
      '# Units: metres',
      `mtllib ${baseName}.mtl`,
      '',
    ];

    const mtlLines: string[] = ['# Smart Life IoT Platform — floor plan materials', ''];

    // OBJ indices are 1-based and continue across groups, so the running offset
    // has to be tracked rather than reset per group.
    let vertexOffset = 1;
    let normalOffset = 1;
    const seen = new Set<string>();

    for (const group of groups) {
      const vertexCount = group.positions.length / 3;
      if (vertexCount === 0 || group.indices.length === 0) continue;

      const materialName = group.material.name.replace(/\s+/g, '_');

      if (!seen.has(materialName)) {
        seen.add(materialName);
        const [r, g, b, a] = group.material.color;
        mtlLines.push(
          `newmtl ${materialName}`,
          `Kd ${r.toFixed(4)} ${g.toFixed(4)} ${b.toFixed(4)}`,
          'Ka 0.0000 0.0000 0.0000',
          `Ks ${group.material.metallic.toFixed(4)} ${group.material.metallic.toFixed(4)} ${group.material.metallic.toFixed(4)}`,
          // OBJ has no roughness; Ns is the nearest analogue, mapped so rough
          // surfaces get a low exponent.
          `Ns ${Math.max(1, Math.round((1 - group.material.roughness) * 200))}`,
          `d ${a.toFixed(4)}`,
          'illum 2',
          '',
        );
      }

      objLines.push(`g ${materialName}`, `usemtl ${materialName}`);

      for (let i = 0; i < vertexCount; i++) {
        const x = group.positions[i * 3];
        const y = group.positions[i * 3 + 1];
        const z = group.positions[i * 3 + 2];
        objLines.push(
          upAxis === 'y-up'
            ? `v ${x.toFixed(6)} ${z.toFixed(6)} ${(-y).toFixed(6)}`
            : `v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`,
        );
      }

      for (let i = 0; i < vertexCount; i++) {
        const nx = group.normals[i * 3];
        const ny = group.normals[i * 3 + 1];
        const nz = group.normals[i * 3 + 2];
        objLines.push(
          upAxis === 'y-up'
            ? `vn ${nx.toFixed(6)} ${nz.toFixed(6)} ${(-ny).toFixed(6)}`
            : `vn ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}`,
        );
      }

      for (let i = 0; i < group.indices.length; i += 3) {
        // Winding preserved in both modes — see the note in gltf.exporter.ts:
        // the y-up map is a rotation (det +1), not a mirror.
        const a = group.indices[i];
        const b = group.indices[i + 1];
        const c = group.indices[i + 2];

        objLines.push(
          `f ${a + vertexOffset}//${a + normalOffset} ` +
            `${b + vertexOffset}//${b + normalOffset} ` +
            `${c + vertexOffset}//${c + normalOffset}`,
        );
      }

      objLines.push('');
      vertexOffset += vertexCount;
      normalOffset += vertexCount;
    }

    return {
      obj: Buffer.from(objLines.join('\n'), 'utf8'),
      mtl: Buffer.from(mtlLines.join('\n'), 'utf8'),
    };
  }

  /** Binary STL. No materials — every group merges into one shell. */
  static toSTL(groups: MeshGroup[]): Buffer {
    let triangleCount = 0;
    for (const group of groups) triangleCount += group.indices.length / 3;

    // 80-byte header + 4-byte count + 50 bytes per facet.
    const buffer = Buffer.alloc(84 + triangleCount * 50);
    buffer.write(
      'Smart Life IoT Platform floor plan export'.padEnd(80, ' '),
      0,
      80,
      'ascii',
    );
    buffer.writeUInt32LE(triangleCount, 80);

    let offset = 84;

    for (const group of groups) {
      for (let i = 0; i < group.indices.length; i += 3) {
        const ia = group.indices[i];
        const ib = group.indices[i + 1];
        const ic = group.indices[i + 2];

        // Facet normal from the first vertex — exact here, since the builder
        // emits flat-shaded faces.
        buffer.writeFloatLE(group.normals[ia * 3], offset);
        buffer.writeFloatLE(group.normals[ia * 3 + 1], offset + 4);
        buffer.writeFloatLE(group.normals[ia * 3 + 2], offset + 8);
        offset += 12;

        for (const index of [ia, ib, ic]) {
          buffer.writeFloatLE(group.positions[index * 3], offset);
          buffer.writeFloatLE(group.positions[index * 3 + 1], offset + 4);
          buffer.writeFloatLE(group.positions[index * 3 + 2], offset + 8);
          offset += 12;
        }

        // Attribute byte count — unused, must be zero.
        buffer.writeUInt16LE(0, offset);
        offset += 2;
      }
    }

    return buffer;
  }
}
