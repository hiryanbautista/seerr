import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIOSPushDelivery1794186501446 implements MigrationInterface {
  name = 'AddIOSPushDelivery1794186501446';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ios_push_delivery" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "ok" boolean NOT NULL, "environment" varchar NOT NULL, "userId" integer, "tokenSuffix" varchar NOT NULL, "type" varchar, "reason" varchar)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_785c62c1e40104659737f4a9b7" ON "ios_push_delivery" ("createdAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_785c62c1e40104659737f4a9b7"`);
    await queryRunner.query(`DROP TABLE "ios_push_delivery"`);
  }
}
