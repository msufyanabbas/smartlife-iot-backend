import { ApiProperty } from '@nestjs/swagger';

export class BaseResponseDto<T = any> {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty()
  data?: T;

  @ApiProperty({ example: 'Operation completed successfully' })
  message?: string;

  @ApiProperty({ example: '2024-10-23T10:00:00.000Z' })
  timestamp: string;

  constructor(partial: Partial<BaseResponseDto<T>>) {
    Object.assign(this, partial);
    this.timestamp = new Date().toISOString();
  }

  static success<T>(data: T, message?: string): BaseResponseDto<T> {
    return new BaseResponseDto<T>({
      success: true,
      data,
      message,
    });
  }

  static error(message: string): BaseResponseDto<null> {
    return new BaseResponseDto<null>({
      success: false,
      message,
    });
  }
}

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: boolean;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ example: 'Bad Request' })
  message: string | string[];

  @ApiProperty({ example: 'Bad Request' })
  error?: string;

  @ApiProperty({ example: '2024-10-23T10:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/auth/login' })
  path?: string;
}
