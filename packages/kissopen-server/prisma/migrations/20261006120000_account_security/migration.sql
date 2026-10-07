ALTER TABLE "CommunityIdentity"
 ADD COLUMN "username" TEXT, ADD COLUMN "passwordHash" TEXT,
 ADD COLUMN "totpSecret" TEXT, ADD COLUMN "totpLastStep" BIGINT NOT NULL DEFAULT -1,
 ADD COLUMN "recoveryHashes" TEXT NOT NULL DEFAULT '[]',
 ADD COLUMN "totpPending" TEXT, ADD COLUMN "totpSetupHash" TEXT,
 ADD COLUMN "totpSetupSession" TEXT, ADD COLUMN "totpSetupExpires" TIMESTAMP(3),
 ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "CommunityIdentity_username_key" ON "CommunityIdentity"("username");
DROP INDEX "CommunityIdentity_provider_subject_key";
CREATE INDEX "CommunityIdentity_provider_subject_idx" ON "CommunityIdentity"("provider","subject");
CREATE TABLE "CommunityOAuthBinding" (
 "provider" TEXT NOT NULL, "subject" TEXT NOT NULL, "identityId" TEXT NOT NULL,
 PRIMARY KEY ("provider","subject"),
 FOREIGN KEY ("identityId") REFERENCES "CommunityIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CommunityOAuthBinding_identityId_provider_key" ON "CommunityOAuthBinding"("identityId","provider");
INSERT INTO "CommunityOAuthBinding"("provider","subject","identityId") SELECT "provider","subject","id" FROM "CommunityIdentity";
CREATE TABLE "CommunitySecurityProof" ("tokenHash" TEXT PRIMARY KEY,"sessionHash" TEXT NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "CommunitySecurityProof_expiresAt_idx" ON "CommunitySecurityProof"("expiresAt");
CREATE TABLE "CommunityAuthThrottle" ("key" TEXT PRIMARY KEY,"count" INTEGER NOT NULL,"expiresAt" TIMESTAMP(3) NOT NULL);
CREATE INDEX "CommunityAuthThrottle_expiresAt_idx" ON "CommunityAuthThrottle"("expiresAt");
ALTER TABLE "CommunityOAuthLogin" ADD COLUMN "intent" TEXT NOT NULL DEFAULT 'signin', ADD COLUMN "targetIdentityId" TEXT,
 ADD COLUMN "sessionHash" TEXT, ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "CommunityAccountSession" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'oauth';
