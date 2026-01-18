import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DWGGeometry } from './entities/floor-plan.entity';

const execAsync = promisify(exec);

/**
 * DWG Parser Service
 * 
 * This service handles parsing of DWG files to extract geometric data.
 * 
 * IMPLEMENTATION OPTIONS:
 * 
 * 1. LibreDWG (Open Source - Recommended for production)
 *    - Install: apt-get install libredwg-dev
 *    - Convert DWG to JSON using dwg2json utility
 *    - Free and actively maintained
 * 
 * 2. ODA File Converter (Teigha)
 *    - Convert DWG to DXF, then parse DXF
 *    - Free but requires registration
 * 
 * 3. Commercial APIs (AutoCAD API, Aspose.CAD)
 *    - Most accurate but costly
 * 
 * This implementation uses LibreDWG approach as placeholder.
 * You can swap with commercial API if needed.
 */
@Injectable()
export class DWGParserService {
  private readonly logger = new Logger(DWGParserService.name);

  /**
   * Parse DWG file and extract geometry data
   */
  async parseDWGFile(filePath: string): Promise<DWGGeometry> {
    try {
      this.logger.log(`Starting DWG parsing for file: ${filePath}`);

      // Check if file exists
      await fs.access(filePath);

      // Method 1: Using LibreDWG (if installed)
      // Uncomment when LibreDWG is installed on your system
      // const geometry = await this.parseWithLibreDWG(filePath);

      // Method 2: Placeholder parser (for development)
      const geometry = await this.parseDWGPlaceholder(filePath);

      this.logger.log(`DWG parsing completed successfully`);
      return geometry;
    } catch (error) {
      this.logger.error(`Failed to parse DWG file: ${error.message}`, error.stack);
      throw new Error(`DWG parsing failed: ${error.message}`);
    }
  }

  /**
   * Parse using LibreDWG (Production-ready approach)
   * 
   * Installation:
   * - Ubuntu/Debian: sudo apt-get install libredwg-dev
   * - macOS: brew install libredwg
   * 
   * This converts DWG to JSON format which we then parse
   */
  private async parseWithLibreDWG(filePath: string): Promise<DWGGeometry> {
    const jsonOutputPath = filePath.replace(/\.dwg$/i, '.json');

    try {
      // Convert DWG to JSON using dwg2json utility
      const { stdout, stderr } = await execAsync(
        `dwg2json "${filePath}" -o "${jsonOutputPath}"`,
      );

      if (stderr && !stderr.includes('warning')) {
        this.logger.warn(`DWG conversion warnings: ${stderr}`);
      }

      // Read the generated JSON
      const jsonContent = await fs.readFile(jsonOutputPath, 'utf-8');
      const dwgData = JSON.parse(jsonContent);

      // Parse the JSON structure and extract geometry
      const geometry = this.extractGeometryFromJSON(dwgData);

      // Clean up temporary JSON file
      await fs.unlink(jsonOutputPath).catch(() => {});

      return geometry;
    } catch (error) {
      this.logger.error(`LibreDWG parsing error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract geometry from LibreDWG JSON output
   */
  private extractGeometryFromJSON(dwgData: any): DWGGeometry {
    const geometry: DWGGeometry = {
      walls: [],
      doors: [],
      windows: [],
      rooms: [],
      stairs: [],
      furniture: [],
    };

    // Parse entities from DWG JSON
    const entities = dwgData.entities || [];

    entities.forEach((entity: any) => {
      switch (entity.type) {
        case 'LINE':
        case 'LWPOLYLINE':
        case 'POLYLINE':
          // These could represent walls
          this.extractWalls(entity, geometry);
          break;

        case 'INSERT':
          // Block references could be doors, windows, furniture
          this.extractBlockReference(entity, geometry);
          break;

        case 'HATCH':
          // Hatches could represent rooms/zones
          this.extractRooms(entity, geometry);
          break;

        case 'TEXT':
        case 'MTEXT':
          // Text labels for rooms
          this.extractTextLabels(entity, geometry);
          break;
      }
    });

    // Post-process to identify rooms from wall boundaries
    this.identifyRooms(geometry);

    return geometry;
  }

  private extractWalls(entity: any, geometry: DWGGeometry): void {
    const points = this.getEntityPoints(entity);
    
    if (points.length >= 2) {
      geometry.walls.push({
        id: entity.handle || this.generateId(),
        points: points,
        thickness: entity.thickness || 0.2, // Default wall thickness
        height: entity.height || 3.0, // Default wall height
        material: entity.layer || 'default',
      });
    }
  }

  private extractBlockReference(entity: any, geometry: DWGGeometry): void {
    const blockName = entity.name?.toLowerCase() || '';
    const position = {
      x: entity.insertion_point?.x || 0,
      y: entity.insertion_point?.y || 0,
      z: entity.insertion_point?.z || 0,
    };

    // Identify block type by name patterns
    if (blockName.includes('door') || blockName.includes('dr')) {
      geometry.doors.push({
        id: entity.handle || this.generateId(),
        position,
        width: entity.x_scale || 0.9,
        height: entity.z_scale || 2.1,
        rotation: entity.rotation || 0,
        type: blockName.includes('double') ? 'double' : 'single',
      });
    } else if (blockName.includes('window') || blockName.includes('win')) {
      geometry.windows.push({
        id: entity.handle || this.generateId(),
        position,
        width: entity.x_scale || 1.2,
        height: entity.z_scale || 1.5,
        rotation: entity.rotation || 0,
      });
    } else {
      // Treat as furniture
      geometry.furniture?.push({
        id: entity.handle || this.generateId(),
        type: blockName,
        position,
        rotation: entity.rotation || 0,
        dimensions: {
          width: entity.x_scale || 1,
          height: entity.z_scale || 1,
          depth: entity.y_scale || 1,
        },
      });
    }
  }

  private extractRooms(entity: any, geometry: DWGGeometry): void {
    const boundaries = this.getEntityPoints(entity);
    
    if (boundaries.length >= 3) {
      const area = this.calculatePolygonArea(boundaries);
      
      geometry.rooms.push({
        id: entity.handle || this.generateId(),
        name: entity.layer || 'Room',
        boundaries,
        area,
        floor: 'ground', // Will be updated based on context
      });
    }
  }

  private extractTextLabels(entity: any, geometry: DWGGeometry): void {
    // Associate text labels with nearby rooms
    const text = entity.text_value || '';
    const position = {
      x: entity.insertion_point?.x || 0,
      y: entity.insertion_point?.y || 0,
    };

    // Find nearest room and update its name
    const nearestRoom = this.findNearestRoom(position, geometry.rooms);
    if (nearestRoom && text.trim()) {
      nearestRoom.name = text.trim();
    }
  }

  /**
   * Placeholder parser for development/testing
   * This generates sample geometry data
   * Replace with actual parser in production
   */
  private async parseDWGPlaceholder(filePath: string): Promise<DWGGeometry> {
    this.logger.warn('Using placeholder DWG parser - install LibreDWG for production use');

    // Get file size to simulate processing time
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    // Simulate parsing delay (100ms per MB)
    await new Promise(resolve => setTimeout(resolve, fileSizeMB * 100));

    // Return sample geometry structure
    return {
      walls: [
        {
          id: 'wall-1',
          points: [
            { x: 0, y: 0, z: 0 },
            { x: 10, y: 0, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
        {
          id: 'wall-2',
          points: [
            { x: 10, y: 0, z: 0 },
            { x: 10, y: 8, z: 0 },
          ],
          thickness: 0.2,
          height: 3.0,
          material: 'concrete',
        },
      ],
      doors: [
        {
          id: 'door-1',
          position: { x: 5, y: 0, z: 0 },
          width: 0.9,
          height: 2.1,
          rotation: 0,
          type: 'single',
        },
      ],
      windows: [
        {
          id: 'window-1',
          position: { x: 2, y: 8, z: 1.2 },
          width: 1.5,
          height: 1.2,
          rotation: 90,
        },
      ],
      rooms: [
        {
          id: 'room-1',
          name: 'Office',
          boundaries: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 },
            { x: 0, y: 8 },
          ],
          area: 80,
          floor: 'ground',
        },
      ],
      stairs: [],
      furniture: [],
    };
  }

  /**
   * Helper methods
   */

  private getEntityPoints(entity: any): Array<{ x: number; y: number; z?: number }> {
    const points: Array<{ x: number; y: number; z?: number }> = [];

    if (entity.vertices && Array.isArray(entity.vertices)) {
      entity.vertices.forEach((vertex: any) => {
        points.push({
          x: vertex.x || 0,
          y: vertex.y || 0,
          z: vertex.z,
        });
      });
    } else if (entity.start && entity.end) {
      points.push(
        { x: entity.start.x || 0, y: entity.start.y || 0, z: entity.start.z },
        { x: entity.end.x || 0, y: entity.end.y || 0, z: entity.end.z },
      );
    }

    return points;
  }

  private calculatePolygonArea(points: Array<{ x: number; y: number }>): number {
    let area = 0;
    const n = points.length;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += points[i].x * points[j].y;
      area -= points[j].x * points[i].y;
    }

    return Math.abs(area / 2);
  }

  private findNearestRoom(
    position: { x: number; y: number },
    rooms: Array<{ boundaries: Array<{ x: number; y: number }>; name: string }>,
  ): any {
    let nearestRoom = null;
    let minDistance = Infinity;

    rooms.forEach((room: any) => {
      // Calculate centroid of room
      const centroid = this.calculateCentroid(room.boundaries);
      const distance = Math.sqrt(
        Math.pow(position.x - centroid.x, 2) +
        Math.pow(position.y - centroid.y, 2),
      );

      if (distance < minDistance) {
        minDistance = distance;
        nearestRoom = room;
      }
    });

    return nearestRoom;
  }

  private calculateCentroid(points: Array<{ x: number; y: number }>): { x: number; y: number } {
    const sum = points.reduce(
      (acc, point) => ({
        x: acc.x + point.x,
        y: acc.y + point.y,
      }),
      { x: 0, y: 0 },
    );

    return {
      x: sum.x / points.length,
      y: sum.y / points.length,
    };
  }

  private identifyRooms(geometry: DWGGeometry): void {
    // Advanced: Identify enclosed spaces from wall boundaries
    // This is a complex algorithm that would analyze wall intersections
    // to find closed polygons representing rooms
    
    // For now, rooms are identified from HATCH entities
    // You can implement more sophisticated room detection here
  }

  private generateId(): string {
    return `entity-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Validate parsed geometry
   */
  validateGeometry(geometry: DWGGeometry): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!geometry.walls || geometry.walls.length === 0) {
      errors.push('No walls found in DWG file');
    }

    if (!geometry.rooms || geometry.rooms.length === 0) {
      errors.push('No rooms identified in DWG file');
    }

    geometry.walls?.forEach((wall, index) => {
      if (!wall.points || wall.points.length < 2) {
        errors.push(`Wall ${index + 1} has invalid points`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Generate thumbnail from geometry data
   * This creates a 2D preview image of the floor plan
   */
  async generateThumbnail(
    geometry: DWGGeometry,
    outputPath: string,
  ): Promise<string> {
    // TODO: Implement thumbnail generation using canvas or similar
    // For now, return placeholder
    this.logger.log('Thumbnail generation not yet implemented');
    return outputPath;
  }
}