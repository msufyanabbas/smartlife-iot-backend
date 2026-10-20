import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from '@modules/devices/entities/device.entity';
import { Telemetry } from '@modules/telemetry/entities/telemetry.entity';
import { GatewayModule } from '@modules/gateway/gateway.module';
import { ScadaDiagram } from './entities/scada-diagram.entity';
import { ScadaElementBinding } from './entities/scada-element-binding.entity';
import { ScadaService } from './scada.service';
import { ScadaController } from './scada.controller';

/**
 * `Device` and `Telemetry` are registered as REPOSITORIES rather than by
 * importing DevicesModule and TelemetryModule.
 *
 * Both of those pull in WebsocketModule and NotificationsModule, and importing
 * either closes a module-load cycle that crashes bootstrap — the same trap
 * `AiModule` and `WebsocketGateway` both document. This module only needs
 * reads (is this device in my tenant; what was its last reading), which the
 * repositories cover without the service graph behind them.
 *
 * GatewayModule IS imported, because the write-back route genuinely needs
 * `GatewayService.sendCommand` / `sendRpcRequest` — there is no way to publish
 * to the broker through a repository. It is wrapped in `forwardRef` because
 * GatewayModule imports DevicesModule, and leaving the resolution order to
 * chance is how the "works locally, crashes in the container" class of boot
 * failure (§4h) gets written again.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScadaDiagram,
      ScadaElementBinding,
      Device,
      Telemetry,
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [ScadaController],
  providers: [ScadaService],
  exports: [ScadaService],
})
export class ScadaModule {}
