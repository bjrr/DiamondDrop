-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('staff', 'system', 'customer');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('pending', 'succeeded', 'failed', 'in_doubt');

-- CreateTable
CREATE TABLE "policy_version" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acknowledgment" (
    "id" UUID NOT NULL,
    "exact_text" TEXT NOT NULL,
    "policy_version_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMP(3) NOT NULL,
    "affirmative_action_label" TEXT NOT NULL,
    "customer_ref" TEXT,
    "order_ref" TEXT,
    "cart_ref" TEXT,
    "campaign_ref" TEXT,
    "submission_ref" TEXT,
    "product_ref" TEXT,
    "variant_ref" TEXT,
    "source_ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acknowledgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshot" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_ref" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" UUID NOT NULL,
    "shopify_event_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shop_domain" TEXT,
    "raw_body" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'pending',
    "request_payload" JSONB,
    "result_payload" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_version_slug_version_key" ON "policy_version"("slug", "version");

-- CreateIndex
CREATE INDEX "policy_version_slug_idx" ON "policy_version"("slug");

-- CreateIndex
CREATE INDEX "acknowledgment_policy_version_id_idx" ON "acknowledgment"("policy_version_id");

-- CreateIndex
CREATE INDEX "acknowledgment_customer_ref_idx" ON "acknowledgment"("customer_ref");

-- CreateIndex
CREATE INDEX "acknowledgment_order_ref_idx" ON "acknowledgment"("order_ref");

-- CreateIndex
CREATE INDEX "acknowledgment_campaign_ref_idx" ON "acknowledgment"("campaign_ref");

-- CreateIndex
CREATE INDEX "snapshot_kind_idx" ON "snapshot"("kind");

-- CreateIndex
CREATE INDEX "snapshot_content_hash_idx" ON "snapshot"("content_hash");

-- CreateIndex
CREATE INDEX "audit_event_entity_type_entity_id_idx" ON "audit_event"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_shopify_event_id_key" ON "webhook_event"("shopify_event_id");

-- CreateIndex
CREATE INDEX "webhook_event_topic_idx" ON "webhook_event"("topic");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_key_key" ON "idempotency_key"("key");

-- CreateIndex
CREATE INDEX "idempotency_key_operation_type_idx" ON "idempotency_key"("operation_type");

-- CreateIndex
CREATE INDEX "idempotency_key_status_idx" ON "idempotency_key"("status");

-- AddForeignKey
ALTER TABLE "acknowledgment" ADD CONSTRAINT "acknowledgment_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
