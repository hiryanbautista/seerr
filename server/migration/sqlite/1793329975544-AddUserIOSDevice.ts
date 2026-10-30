import type { MigrationInterface, QueryRunner } from 'typeorm';

// Fork-only: APNs device tokens for the iOS app.
export class AddUserIOSDevice1793329975544 implements MigrationInterface {
  name = 'AddUserIOSDevice1793329975544';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "user_ios_device" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "token" varchar NOT NULL, "createdAt" datetime DEFAULT (CURRENT_TIMESTAMP), "userId" integer, CONSTRAINT "UQ_1a5c63b5f1ec0e2ea77ee0e1e38" UNIQUE ("token"), CONSTRAINT "FK_ee9566da9e2d476a1be7fdc31c7" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ee9566da9e2d476a1be7fdc31c" ON "user_ios_device" ("userId") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_ee9566da9e2d476a1be7fdc31c"`);
    await queryRunner.query(`DROP TABLE "user_ios_device"`);
  }
}
