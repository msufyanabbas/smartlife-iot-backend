import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { toQueryBoolean } from '@common/transformers/query-boolean.transformer';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Query flags for `GET /floor-plans/:id/display-geometry`.
 *
 * Each one turns a single transformation OFF, so a defect can be bisected
 * against a real drawing without a rebuild: if walls look wrong, ask for
 * `pairWalls=false` and compare. They default ON, so the plain URL returns the
 * correct, fully processed geometry.
 */
export class DisplayGeometryQueryDto {
  @ApiPropertyOptional({
    description:
      'Apply the CAD drawing standard. False returns every line in the drawing as a wall — ' +
      'the behaviour that put the sheet title block and the text of the general notes into ' +
      'the 3D model. For comparison only.',
    default: true,
  })
  @IsOptional()
  // ── Why @Transform, and why the SHARED one ──────────────────────────────
  //
  // A query string is text, and `Boolean('false')` is TRUE, so a bare
  // `@IsBoolean()` makes `?enforceStandard=false` enable it.
  //
  // A hand-written `@Transform(({ value }) => value === 'true')` does NOT fix
  // that, which is the trap: the pipe's implicit conversion runs BEFORE the
  // transform, so `value` is already `true` and the original string is gone.
  // The first version of this file made exactly that mistake, in four places,
  // and so did the assets DTOs — all of them looking like fixes and changing
  // nothing. `toQueryBoolean` reads `obj[key]`, the untransformed source.
  @Transform(toQueryBoolean)
  @IsBoolean()
  enforceStandard?: boolean;

  @ApiPropertyOptional({
    description:
      'Build geometry on layers the standard does not recognise, while still ' +
      'excluding the ones it recognises as annotation, hatch or grid. This is ' +
      'the setting for a drawing that does not follow NCS layer naming — ' +
      '`WALLS`, `Mur`, `Layer1`, an Arabic name — where the strict reading is ' +
      'an empty model. Much narrower than `enforceStandard=false`, which also ' +
      'readmits the title block and the text of the general notes.',
    default: false,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean()
  keepUnrecognised?: boolean;

  @ApiPropertyOptional({
    description:
      'Pair the two drawn faces of each wall into one wall of the measured thickness. ' +
      'False leaves every drawn line as its own wall at the default thickness.',
    default: true,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean()
  pairWalls?: boolean;

  @ApiPropertyOptional({
    description:
      'Split walls around their doors and windows. False returns whole walls, with the ' +
      'openings still listed but nothing cut for them.',
    default: true,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean()
  cutOpenings?: boolean;

  @ApiPropertyOptional({
    description:
      'Detect the X convention — an X drawn over a space means that space is empty, so ' +
      'nothing is placed in it. The floor and walls are built either way.',
    default: true,
  })
  @IsOptional()
  @Transform(toQueryBoolean)
  @IsBoolean()
  detectXVoids?: boolean;

  @ApiPropertyOptional({
    description:
      'Storey height in METRES, when the drawing does not state one. Ignored where the ' +
      'drawing carries a floor-to-floor level.',
    minimum: 1.8,
    maximum: 20,
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsNumber()
  @Min(1.8)
  @Max(20)
  wallHeight?: number;
}
