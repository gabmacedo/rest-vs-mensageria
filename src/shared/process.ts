import { validateOrder, type OrderEnvelope } from "./order.js"
import { saveOrder } from "./repository.js"

export async function processOrder(envelope: OrderEnvelope): Promise<void> {
  const order = validateOrder(envelope?.order)
  await saveOrder(order, new Date(envelope.receivedAt))
}
