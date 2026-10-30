import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './User';

// Fork-only: APNs device tokens for the iOS app. Kept in its own table so
// upstream SQLite migrations that rebuild user_settings never drop it.
@Entity()
export class UserIOSDevice {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, { eager: true, onDelete: 'CASCADE' })
  @Index()
  public user: User;

  @Column({ unique: true })
  public token: string;

  @DbAwareColumn({
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: true,
  })
  public createdAt: Date;

  constructor(init?: Partial<UserIOSDevice>) {
    Object.assign(this, init);
  }
}
