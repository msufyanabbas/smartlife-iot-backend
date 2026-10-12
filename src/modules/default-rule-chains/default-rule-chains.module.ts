import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DefaultRuleChain } from './entities/default-rule-chain.entity';
import { RuleChain } from '@modules/rules/entities/rule-chain.entity';
import { Device } from '@modules/devices/entities/device.entity';
import { DeviceProfile } from '@modules/profiles/entities/device-profile.entity';
import { DefaultRuleChainsController } from './default-rule-chains.controller';
import { DefaultRuleChainsService } from './default-rule-chains.service';
import { DefaultRuleChainResolverService } from './default-rule-chain-resolver.service';

/**
 * Repositories only — no sibling feature module is imported, so this module
 * cannot take part in a cycle. That is load bearing here: `RulesModule`
 * imports THIS module so `RuleEngineConsumer` can ask the resolver which chain
 * handles a message, and importing `RulesModule`, `DevicesModule` or
 * `ProfilesModule` back would close the loop.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DefaultRuleChain,
      RuleChain,
      Device,
      DeviceProfile,
    ]),
  ],
  controllers: [DefaultRuleChainsController],
  providers: [DefaultRuleChainsService, DefaultRuleChainResolverService],
  exports: [DefaultRuleChainsService, DefaultRuleChainResolverService],
})
export class DefaultRuleChainsModule {}
