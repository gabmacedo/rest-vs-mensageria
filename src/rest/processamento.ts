import Fastify from "fastify"
import { ValidationError, type OrderEnvelope } from "../shared/order.js"
import { processOrder } from "../shared/process.js"
import { prisma } from "../shared/repository.js"

const app = Fastify({ logger: false })

app.get("/health", async () => ({ ok: true }))

app.post<{ Body: OrderEnvelope }>("/orders", async (req, reply) => {
  try {
    await processOrder(req.body)
    return reply.code(201).send({ status: "processed", id: req.body.order.id })
  } catch (err) {
    if (err instanceof ValidationError)
      return reply.code(400).send({ error: err.message })
    req.log.error(err)
    return reply.code(500).send({ error: "falha ao gravar" })
  }
})

const close = async () => {
  await app.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on("SIGTERM", close)
process.on("SIGINT", close)

await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) })
console.log("[rest-processamento] ouvindo")
