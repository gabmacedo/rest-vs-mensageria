export interface OrderItem {
  sku: string
  quantity: number
  price: number
}

export interface OrderPayload {
  id: string
  customerId: string
  items: OrderItem[]
  total: number
}

export interface OrderEnvelope {
  order: OrderPayload
  receivedAt: string
}

export class ValidationError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function validateOrder(input: unknown): OrderPayload {
  if (typeof input !== "object" || input === null)
    throw new ValidationError("pedido ausente")
  const o = input as Record<string, unknown>
  if (typeof o.id !== "string" || !UUID.test(o.id))
    throw new ValidationError("id inválido")
  if (typeof o.customerId !== "string" || o.customerId.length === 0)
    throw new ValidationError("customerId inválido")
  if (!Array.isArray(o.items) || o.items.length === 0)
    throw new ValidationError("items inválidos")

  let sum = 0
  const items: OrderItem[] = o.items.map((raw, i) => {
    const it = raw as Record<string, unknown>
    if (typeof it.sku !== "string" || it.sku.length === 0)
      throw new ValidationError(`items[${i}].sku inválido`)
    if (!Number.isInteger(it.quantity) || (it.quantity as number) <= 0)
      throw new ValidationError(`items[${i}].quantity inválida`)
    if (typeof it.price !== "number" || !(it.price > 0))
      throw new ValidationError(`items[${i}].price inválido`)
    sum += (it.quantity as number) * it.price
    return { sku: it.sku, quantity: it.quantity as number, price: it.price }
  })

  if (typeof o.total !== "number" || Math.abs(o.total - sum) > 0.01)
    throw new ValidationError("total não confere com os itens")
  return { id: o.id, customerId: o.customerId, items, total: o.total }
}
