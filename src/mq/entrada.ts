import Fastify from "fastify"
import type { OrderEnvelope, OrderPayload } from "../shared/order.js"
import { QUEUE, connectWithRetry } from "./amqp.js"

const conn = await connectWithRetry("mq-entrada")
const channel = await conn.createConfirmChannel()
await channel.assertQueue(QUEUE, { durable: true })

function publish(envelope: OrderEnvelope): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.sendToQueue(
      QUEUE,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: envelope.order.id,
      },
      (err) => (err ? reject(err) : resolve()),
    )
  })
}

const app = Fastify({ logger: false })
app.get("/health", async () => ({ ok: true }))

app.post<{ Body: OrderPayload }>("/orders", async (req, reply) => {
  const envelope: OrderEnvelope = {
    order: req.body,
    receivedAt: new Date().toISOString(),
  }
  try {
    await publish(envelope)
    return reply.code(202).send({ status: "accepted", id: req.body?.id })
  } catch {
    return reply.code(503).send({ error: "broker indisponível" })
  }
})

process.on("SIGTERM", async () => {
  await app.close()
  await conn.close().catch(() => {})
  process.exit(0)
})
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) })
console.log("[mq-entrada] ouvindo")
