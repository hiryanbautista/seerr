import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// One row per iOS push attempt for the admin delivery status. userId has no
// foreign key so history survives user deletion; only the token's last 6
// characters are stored.
@Entity()
export class IOSPushDelivery {
  @PrimaryGeneratedColumn()
  public id: number;

  @Index()
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @Column()
  public ok: boolean;

  @Column()
  public environment: 'production' | 'sandbox';

  @Column({ type: 'integer', nullable: true })
  public userId: number | null;

  @Column()
  public tokenSuffix: string;

  @Column({ type: 'varchar', nullable: true })
  public type: string | null;

  @Column({ type: 'varchar', nullable: true })
  public reason: string | null;

  constructor(init?: Partial<IOSPushDelivery>) {
    Object.assign(this, init);
  }
}
