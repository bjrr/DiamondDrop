-- Group Buy Bank Payment checkout (docs/SLICE-2-AND-GROUP-BUY-OWNER-
-- DECISIONS.md §14, §24). See the schema.prisma comment directly above
-- `enum GroupBuyBankPaymentOrderStatus` for why this is a SEPARATE model
-- from `BankPaymentOrder` rather than a reuse of it.

-- CreateEnum
CREATE TYPE "group_buy_bank_payment_order_status" AS ENUM ('active', 'inactive');

-- CreateTable
CREATE TABLE "group_buy_bank_payment_order" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "shopify_draft_order_gid" TEXT NOT NULL,
    "shopify_order_gid" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "customer_gid" TEXT NOT NULL,
    "status" "group_buy_bank_payment_order_status" NOT NULL DEFAULT 'active',
    "tier_number_at_quote" INTEGER NOT NULL,
    "quoted_at" TIMESTAMPTZ(6) NOT NULL,
    "inactivated_at" TIMESTAMPTZ(6),
    "reactivated_at" TIMESTAMPTZ(6),
    "reactivated_by" TEXT,
    "reactivation_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "group_buy_bank_payment_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_buy_bank_payment_order_line" (
    "id" UUID NOT NULL,
    "group_buy_bank_payment_order_id" UUID NOT NULL,
    "master_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "quoted_bank_payment_price_minor_units" BIGINT NOT NULL,
    "quoted_regular_card_price_minor_units" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_buy_bank_payment_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_bank_payment_order_shopify_draft_order_gid_key" ON "group_buy_bank_payment_order"("shopify_draft_order_gid");

-- CreateIndex
CREATE UNIQUE INDEX "group_buy_bank_payment_order_shopify_order_gid_key" ON "group_buy_bank_payment_order"("shopify_order_gid");

-- CreateIndex
CREATE INDEX "group_buy_bank_payment_order_status_idx" ON "group_buy_bank_payment_order"("status");

-- CreateIndex
CREATE INDEX "group_buy_bank_payment_order_customer_gid_idx" ON "group_buy_bank_payment_order"("customer_gid");

-- CreateIndex
CREATE INDEX "group_buy_bank_payment_order_campaign_id_idx" ON "group_buy_bank_payment_order"("campaign_id");

-- CreateIndex
CREATE INDEX "group_buy_bank_payment_order_line_group_buy_bank_payment_or_idx" ON "group_buy_bank_payment_order_line"("group_buy_bank_payment_order_id");

-- AddForeignKey
ALTER TABLE "group_buy_bank_payment_order" ADD CONSTRAINT "group_buy_bank_payment_order_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "group_buy_campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_bank_payment_order_line" ADD CONSTRAINT "group_buy_bank_payment_order_line_group_buy_bank_payment_o_fkey" FOREIGN KEY ("group_buy_bank_payment_order_id") REFERENCES "group_buy_bank_payment_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_buy_bank_payment_order_line" ADD CONSTRAINT "group_buy_bank_payment_order_line_master_variant_id_fkey" FOREIGN KEY ("master_variant_id") REFERENCES "master_variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
