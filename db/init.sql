-- Gerado a partir de prisma/schema.prisma (npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script)
CREATE TABLE IF NOT EXISTS "orders" (
    "id" UUID NOT NULL,
    "customer_id" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);
