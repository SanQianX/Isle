-- DropIndex
DROP INDEX "Photo_originalKey_key";

-- CreateIndex
CREATE INDEX "Photo_originalKey_idx" ON "Photo"("originalKey");
