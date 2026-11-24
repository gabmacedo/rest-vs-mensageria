import { ValidationError, type OrderEnvelope } from "../shared/order.js"
import { processOrder } from "../shared/process.js"
import { DB_POOL_SIZE, prisma } from "../shared/repository.js"
import { QUEUE, connectWithRetry } from "./amqp.js"

const PREFETCH = Number(process.env.PREFETCH ?? DB_POOL_SIZE)

const conn = await connectWithRetry("mq-processamento")
const channel = await conn.createChannel()
await channel.assertQueue(QUEUE, { durable: true })
await channel.prefetch(PREFETCH)

await channel.consume(
  QUEUE,
  async (msg) => {
    if (!msg) return
    try {
      const envelope = JSON.parse(msg.content.toString()) as OrderEnvelope
      await processOrder(envelope)
      channel.ack(msg)
    } catch (err) {
      if (err instanceof ValidationError || err instanceof SyntaxError)
        channel.nack(msg, false, false)
      else channel.nack(msg, false, true)
    }
  },
  { noAck: false },
)

console.log(`[mq-processamento] consumindo '${QUEUE}' com prefetch=${PREFETCH}`)

const close = async () => {
  await channel.close().catch(() => {})
  await conn.close().catch(() => {})
  await prisma.$disconnect()
  process.exit(0)
}
process.on("SIGTERM", close)
process.on("SIGINT", close)
