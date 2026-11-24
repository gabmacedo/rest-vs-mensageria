import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../generated/prisma/client.js"
import type { OrderPayload } from "./order.js"

export const DB_POOL_SIZE = Number(process.env.DB_POOL_SIZE ?? 10)

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  max: DB_POOL_SIZE,
})
export const prisma = new PrismaClient({ adapter })

export async function saveOrder(
  order: OrderPayload,
  receivedAt: Date,
): Promise<boolean> {
  const r = await prisma.order.createMany({
    data: [
      {
        id: order.id,
        customerId: order.customerId,
        items: order.items as unknown as object,
        total: order.total,
        receivedAt,
      },
    ],
    skipDuplicates: true,
  })
  return r.count === 1
}
