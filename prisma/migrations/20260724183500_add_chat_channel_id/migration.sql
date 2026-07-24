-- Add chatChannelId to minecraft_configs for cross-chat Discord <-> Minecraft bridge
ALTER TABLE "minecraft_configs" ADD COLUMN IF NOT EXISTS "chatChannelId" TEXT;
