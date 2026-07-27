ALTER TABLE "vacation_requests"
ADD COLUMN "roleSnapshotAt" TIMESTAMP(3);

-- Existing live sagas already mutated Discord using their stored snapshots.
-- Seal those snapshots exactly as-is so deployment never recomputes provenance
-- from an already-suppressed member. New pending/terminal rows remain unsealed.
UPDATE "vacation_requests"
SET "roleSnapshotAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE "status" IN ('activating', 'active', 'restoring')
  AND "roleSnapshotAt" IS NULL;
