import http from "k6/http"
import { check } from "k6"
import { Counter } from "k6/metrics"

const TEST = __ENV.TEST || "baixa"
const TARGET = __ENV.TARGET || "http://rest-entrada:3000/orders"
const SCALE = Number(__ENV.SCALE || 1)
const d = (s) => `${Math.max(1, Math.round(s * SCALE))}s`

const base = {
  executor: "ramping-arrival-rate",
  timeUnit: "1s",
  preAllocatedVUs: 200,
  maxVUs: 3000,
}
const SCENARIOS = {
  baixa: {
    executor: "constant-arrival-rate",
    rate: 50,
    timeUnit: "1s",
    duration: d(300),
    preAllocatedVUs: 50,
    maxVUs: 1000,
  },
  crescente: {
    ...base,
    startRate: 50,
    stages: [{ target: 1600, duration: d(300) }],
  },
  pico: {
    ...base,
    startRate: 100,
    stages: [
      { target: 100, duration: d(60) },
      { target: 500, duration: "1s" },
      { target: 500, duration: d(60) },
      { target: 100, duration: "1s" },
      { target: 100, duration: d(60) },
    ],
  },
  limite: {
    ...base,
    startRate: 50,
    preAllocatedVUs: 500,
    maxVUs: 6000,
    stages: [{ target: 6000, duration: d(300) }],
  },
  falha: {
    executor: "constant-arrival-rate",
    rate: 100,
    timeUnit: "1s",
    duration: d(180),
    preAllocatedVUs: 100,
    maxVUs: 2000,
  },
}

export const options = {
  scenarios: { [TEST]: SCENARIOS[TEST] },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "min", "max"],
  discardResponseBodies: true,
}

const accepted = new Counter("pedidos_aceitos")
const rejected = new Counter("pedidos_rejeitados")

function uuid() {
  const h = "0123456789abcdef"
  let s = ""
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += "-"
    else if (i === 14) s += "4"
    else if (i === 19) s += h[(Math.random() * 4) | 8]
    else s += h[(Math.random() * 16) | 0]
  }
  return s
}

// Payload fixo em formato: sempre 3 itens.
function pedido() {
  const items = [1, 2, 3].map((n) => ({
    sku: `SKU-000${n}`,
    quantity: n,
    price: 10 * n + 0.5,
  }))
  const total =
    Math.round(items.reduce((a, it) => a + it.quantity * it.price, 0) * 100) /
    100
  return {
    id: uuid(),
    customerId: `cliente-${(Math.random() * 10000) | 0}`,
    items,
    total,
  }
}

export default function () {
  const res = http.post(TARGET, JSON.stringify(pedido()), {
    headers: { "Content-Type": "application/json" },
    timeout: "10s",
  })
  const ok = res.status === 201 || res.status === 202
  ;(ok ? accepted : rejected).add(1)
  check(res, { "pedido aceito (201/202)": () => ok })
}

export function handleSummary(data) {
  return {
    [__ENV.SUMMARY || "/results/summary.json"]: JSON.stringify(data, null, 2),
  }
}
