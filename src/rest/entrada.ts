import Fastify from "fastify"
import { Agent, fetch } from "undici"
import type { OrderEnvelope, OrderPayload } from "../shared/order.js"

const PROCESSING_URL =
  process.env.PROCESSING_URL ?? "http://rest-processamento:3001/orders"
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 10_000)

const dispatcher = new Agent({ keepAliveTimeout: 30_000, connections: 128 })

const app = Fastify({ logger: false })
app.get("/health", async () => ({ ok: true }))

app.post<{ Body: OrderPayload }>("/orders", async (req, reply) => {
  const envelope: OrderEnvelope = {
    order: req.body,
    receivedAt: new Date().toISOString(),
  }
  try {
    const res = await fetch(PROCESSING_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      dispatcher,
    })
    const body = await res.json().catch(() => ({}))
    return reply.code(res.status).send(body)
  } catch {
    return reply
      .code(503)
      .send({ error: "serviço de processamento indisponível" })
  }
})

process.on("SIGTERM", async () => {
  await app.close()
  process.exit(0)
})
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) })
console.log("[rest-entrada] ouvindo")
