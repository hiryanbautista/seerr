import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIOSPushDelivery1794186548573 implements MigrationInterface {
  name = 'AddIOSPushDelivery1794186548573';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ios_push_delivery" ("id" SERIAL NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ok" boolean NOT NULL, "environment" character varying NOT NULL, "userId" integer, "tokenSuffix" character varying NOT NULL, "type" character varying, "reason" character varying, CONSTRAINT "PK_daf0256b69b1640c9ec6e388d37" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_785c62c1e40104659737f4a9b7" ON "ios_push_delivery" ("createdAt") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_785c62c1e40104659737f4a9b7"`
    );
    await queryRunner.query(`DROP TABLE "ios_push_delivery"`);
  }
}
