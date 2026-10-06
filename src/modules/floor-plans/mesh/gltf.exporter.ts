// src/modules/floor-plans/mesh/gltf.exporter.ts
//
// glTF 2.0 / GLB writer, written directly against the spec.
//
// No library: the Node exporters are either three.js-coupled (a 600 kB
// dependency to write a buffer) or unmaintained, and the subset needed here —
// indexed triangle primitives, PBR metallic-roughness materials, one buffer — is
// small and has not changed since 2017.
//
// Axis convention: glTF is Y-up and viewers assume it. The mesh arrives Z-up
// (DXF). The mapping is gltf.x = dxf.x, gltf.y = dxf.z, gltf.z = -dxf.y.

import type { MeshGroup } from './mesh.builder';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

const COMPONENT_TYPE_FLOAT = 5126;
const COMPONENT_TYPE_UINT32 = 5125;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

export type UpAxis = 'y-up' | 'z-up';

export interface GltfExportOptions {
  upAxis?: UpAxis;
  generator?: string;
  sceneName?: string;
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

/** Pads to the next multiple of 4, as GLB alignment requires. */
function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

export class GltfExporter {
  private static buildDocument(
    groups: MeshGroup[],
    options: GltfExportOptions,
  ): { json: any; binary: Buffer } {
    const upAxis = options.upAxis ?? 'y-up';

    const bufferViews: any[] = [];
    const accessors: Accessor[] = [];
    const materials: any[] = [];
    const primitives: any[] = [];
    const chunks: Buffer[] = [];

    let byteOffset = 0;

    const pushBufferView = (data: Buffer, target: number): number => {
      const padding = pad4(byteOffset);
      if (padding > 0) {
        chunks.push(Buffer.alloc(padding));
        byteOffset += padding;
      }

      bufferViews.push({
        buffer: 0,
        byteOffset,
        byteLength: data.length,
        target,
      });

      chunks.push(data);
      byteOffset += data.length;

      return bufferViews.length - 1;
    };

    groups.forEach((group, groupIndex) => {
      const vertexCount = group.positions.length / 3;
      if (vertexCount === 0 || group.indices.length === 0) return;

      const positions = new Float32Array(group.positions.length);
      const normals = new Float32Array(group.normals.length);

      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];

      for (let i = 0; i < vertexCount; i++) {
        const x = group.positions[i * 3];
        const y = group.positions[i * 3 + 1];
        const z = group.positions[i * 3 + 2];
        const nx = group.normals[i * 3];
        const ny = group.normals[i * 3 + 1];
        const nz = group.normals[i * 3 + 2];

        const px = x;
        const py = upAxis === 'y-up' ? z : y;
        const pz = upAxis === 'y-up' ? -y : z;
        const mx = nx;
        const my = upAxis === 'y-up' ? nz : ny;
        const mz = upAxis === 'y-up' ? -ny : nz;

        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
        positions[i * 3 + 2] = pz;
        normals[i * 3] = mx;
        normals[i * 3 + 1] = my;
        normals[i * 3 + 2] = mz;

        if (px < min[0]) min[0] = px;
        if (py < min[1]) min[1] = py;
        if (pz < min[2]) min[2] = pz;
        if (px > max[0]) max[0] = px;
        if (py > max[1]) max[1] = py;
        if (pz > max[2]) max[2] = pz;
      }

      const positionView = pushBufferView(
        Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength),
        TARGET_ARRAY_BUFFER,
      );
      // POSITION min/max is REQUIRED by the spec — viewers frame the camera with
      // it, and omitting it makes several load the model and show nothing.
      accessors.push({
        bufferView: positionView,
        componentType: COMPONENT_TYPE_FLOAT,
        count: vertexCount,
        type: 'VEC3',
        min,
        max,
      });
      const positionAccessor = accessors.length - 1;

      const normalView = pushBufferView(
        Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength),
        TARGET_ARRAY_BUFFER,
      );
      accessors.push({
        bufferView: normalView,
        componentType: COMPONENT_TYPE_FLOAT,
        count: vertexCount,
        type: 'VEC3',
      });
      const normalAccessor = accessors.length - 1;

      // Winding is NOT reversed, and that is worth spelling out because it looks
      // like it should be. The y-up map (x,y,z) → (x,z,-y) is the matrix
      // [[1,0,0],[0,0,1],[0,-1,0]], determinant +1 — a -90° rotation about X,
      // not a mirror. Handedness is preserved. Reversing the winding here (the
      // reflex reaction to "an axis got negated") desynchronises triangles from
      // their normals and renders the model inside-out.
      const indexData = new Uint32Array(group.indices.length);
      indexData.set(group.indices);

      const indexView = pushBufferView(
        Buffer.from(indexData.buffer, indexData.byteOffset, indexData.byteLength),
        TARGET_ELEMENT_ARRAY_BUFFER,
      );
      accessors.push({
        bufferView: indexView,
        componentType: COMPONENT_TYPE_UINT32,
        count: indexData.length,
        type: 'SCALAR',
      });
      const indexAccessor = accessors.length - 1;

      const material = group.material;
      materials.push({
        name: material.name,
        pbrMetallicRoughness: {
          baseColorFactor: material.color,
          metallicFactor: material.metallic,
          roughnessFactor: material.roughness,
        },
        // BLEND for glazing only; marking an opaque material BLEND costs a
        // sorting pass in every viewer.
        alphaMode: material.transparent ? 'BLEND' : 'OPAQUE',
        doubleSided: material.transparent === true,
      });

      primitives.push({
        attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
        indices: indexAccessor,
        material: groupIndex,
        mode: 4,
      });
    });

    const binary = Buffer.concat(chunks);

    const json = {
      asset: {
        version: '2.0',
        generator:
          options.generator ?? 'Smart Life IoT Platform floor-plan exporter',
      },
      scene: 0,
      scenes: [{ name: options.sceneName ?? 'FloorPlan', nodes: [0] }],
      nodes: [{ name: options.sceneName ?? 'FloorPlan', mesh: 0 }],
      meshes: [{ name: options.sceneName ?? 'FloorPlan', primitives }],
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binary.length }] as any[],
    };

    return { json, binary };
  }

  /** Self-contained binary .glb. */
  static toGLB(groups: MeshGroup[], options: GltfExportOptions = {}): Buffer {
    const { json, binary } = this.buildDocument(groups, options);

    // The spec is explicit: JSON chunk padded with SPACES, BIN with zeros.
    // Strict loaders reject the wrong one.
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const paddedJson = Buffer.concat([
      jsonBuffer,
      Buffer.alloc(pad4(jsonBuffer.length), 0x20),
    ]);
    const paddedBin = Buffer.concat([binary, Buffer.alloc(pad4(binary.length), 0x00)]);

    const totalLength =
      12 + 8 + paddedJson.length + (paddedBin.length > 0 ? 8 + paddedBin.length : 0);

    const header = Buffer.alloc(12);
    header.writeUInt32LE(GLB_MAGIC, 0);
    header.writeUInt32LE(GLB_VERSION, 4);
    header.writeUInt32LE(totalLength, 8);

    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(paddedJson.length, 0);
    jsonHeader.writeUInt32LE(CHUNK_TYPE_JSON, 4);

    const parts = [header, jsonHeader, paddedJson];

    if (paddedBin.length > 0) {
      const binHeader = Buffer.alloc(8);
      binHeader.writeUInt32LE(paddedBin.length, 0);
      binHeader.writeUInt32LE(CHUNK_TYPE_BIN, 4);
      parts.push(binHeader, paddedBin);
    }

    return Buffer.concat(parts);
  }

  /** .gltf JSON with the buffer embedded as a data URI — bigger, but readable. */
  static toGLTF(groups: MeshGroup[], options: GltfExportOptions = {}): Buffer {
    const { json, binary } = this.buildDocument(groups, options);

    json.buffers = [
      {
        byteLength: binary.length,
        uri: `data:application/octet-stream;base64,${binary.toString('base64')}`,
      },
    ];

    return Buffer.from(JSON.stringify(json, null, 2), 'utf8');
  }
}
