import { AlarmCondition } from '@common/enums/index.enum';

export interface AlarmRule {
  telemetryKey: string;
  condition: AlarmCondition;
  value: number;
  value2?: number; // For BETWEEN and OUTSIDE conditions
  duration?: number; // How long condition must be true (seconds)
}