-- CreateTable
CREATE TABLE "Place" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Visitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "displayCode" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "placeId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "originalKey" TEXT NOT NULL,
    "preview400Key" TEXT,
    "preview1200Key" TEXT,
    "originalFileName" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "originalByteLength" INTEGER NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "uploadIdempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_placeId_fkey" FOREIGN KEY ("placeId") REFERENCES "Place" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Vote" (
    "photoId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("photoId", "visitorId"),
    CONSTRAINT "Vote_photoId_fkey" FOREIGN KEY ("photoId") REFERENCES "Photo" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Vote_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RateBucket" (
    "visitorId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,

    PRIMARY KEY ("visitorId", "bucket"),
    CONSTRAINT "RateBucket_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "Visitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Place_slug_key" ON "Place"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Place_normalizedName_key" ON "Place"("normalizedName");

-- CreateIndex
CREATE INDEX "Place_createdAt_idx" ON "Place"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Visitor_tokenHash_key" ON "Visitor"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Visitor_displayCode_key" ON "Visitor"("displayCode");

-- CreateIndex
CREATE INDEX "Visitor_createdAt_idx" ON "Visitor"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_originalKey_key" ON "Photo"("originalKey");

-- CreateIndex
CREATE INDEX "Photo_placeId_status_createdAt_idx" ON "Photo"("placeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Photo_visitorId_createdAt_idx" ON "Photo"("visitorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Photo_visitorId_uploadIdempotencyKey_key" ON "Photo"("visitorId", "uploadIdempotencyKey");

-- CreateIndex
CREATE INDEX "Vote_photoId_value_idx" ON "Vote"("photoId", "value");

-- CreateIndex
CREATE INDEX "RateBucket_expiresAt_idx" ON "RateBucket"("expiresAt");
