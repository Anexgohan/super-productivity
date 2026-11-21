CREATE TABLE "deleted_entities" (
    "user_id" INTEGER NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "deleted_at" BIGINT NOT NULL,
    "recorded_at" BIGINT NOT NULL,

    CONSTRAINT "deleted_entities_pkey" PRIMARY KEY ("user_id", "entity_type", "entity_id")
);

CREATE INDEX "deleted_entities_recorded_at_idx" ON "deleted_entities"("recorded_at");

ALTER TABLE "deleted_entities"
ADD CONSTRAINT "deleted_entities_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
