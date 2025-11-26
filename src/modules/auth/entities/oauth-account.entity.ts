import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '@/common/entities/base.entity';
import { User } from '@/modules/users/entities/user.entity';

export enum OAuthProviderEnum {
  GOOGLE = 'google',
  GITHUB = 'github',
  APPLE = 'apple',
}

@Entity('oauth_accounts')
@Index(['provider', 'providerId'], { unique: true })
export class OAuthAccount extends BaseEntity {
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @Column({
    type: 'enum',
    enum: OAuthProviderEnum,
  })
  provider: OAuthProviderEnum;

  @Column()
  providerId: string;

  @Column({ nullable: true })
  providerEmail?: string;

  @Column({ type: 'text', nullable: true })
  accessToken?: string;

  @Column({ type: 'text', nullable: true })
  refreshToken?: string;

  @Column({ type: 'timestamp', nullable: true })
  tokenExpiresAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  profile?: any;
}
