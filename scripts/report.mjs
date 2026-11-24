import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const OUT = resolve(ROOT, process.argv[2] ?? "results")
const runs = readdirSync(join(OUT, "runs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(OUT, "runs", f), "utf8")))
const machine = existsSync(join(OUT, "machine.json"))
  ? JSON.parse(readFileSync(join(OUT, "machine.json"), "utf8"))
  : {}

const TESTS = ["baixa", "crescente", "pico", "falha", "limite"].filter((t) =>
  runs.some((r) => r.test === t),
)
const NAMES = { rest: "REST (síncrono)", mq: "RabbitMQ (assíncrono)" }
const TEST_NAMES = {
  baixa: "Carga baixa (50 req/s, 5 min)",
  crescente: "Carga crescente (50 → 1.600 req/s, 5 min)",
  pico: "Pico (100 → 500 → 100 req/s)",
  falha: "Falha (100 req/s, processamento desligado 60 s)",
  limite: "Limite – exploratório (50 → 6.000 req/s, 5 min)",
}

const get = (o, path) =>
  path.split(".").reduce((a, k) => (a == null ? a : a[k]), o)
function agg(list, path) {
  const v = list
    .map((r) => get(r, path))
    .filter((x) => typeof x === "number" && Number.isFinite(x))
  if (!v.length) return null
  const m = v.reduce((a, b) => a + b, 0) / v.length
  const sd =
    v.length > 1
      ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
      : 0
  return { m, sd, n: v.length }
}
const fmt = (a, d = 1) =>
  a == null
    ? "–"
    : a.n > 1
      ? `${a.m.toFixed(d)} ± ${a.sd.toFixed(d)}`
      : a.m.toFixed(d)
const sel = (s, t) =>
  runs
    .filter((r) => r.scenario === s && r.test === t)
    .sort((a, b) => a.rep - b.rep)

const ROWS = [
  ["Pedidos enviados", "k6.sent", 0],
  ["Taxa de erros (%)", "k6.errorRatePct", 2],
  ["Iterações descartadas pelo k6", "k6.dropped", 0],
  ["Tempo de resposta – média (ms)", "k6.respAvgMs", 2],
  ["Tempo de resposta – mediana (ms)", "k6.respMedMs", 2],
  ["Tempo de resposta – p95 (ms)", "k6.respP95Ms", 2],
  ["Tempo de resposta – p99 (ms)", "k6.respP99Ms", 2],
  ["Tempo total de processamento – média (ms)", "db.avg", 1],
  ["Tempo total de processamento – mediana (ms)", "db.med", 1],
  ["Tempo total de processamento – p95 (ms)", "db.p95", 1],
  ["Tempo total de processamento – máx. (ms)", "db.max", 0],
  ["Pedidos gravados", "db.count", 0],
  ["Pedidos aceitos e perdidos", "db.lost", 0],
  ["Gravações/s – média", "throughput.avgPerSec", 1],
  ["Gravações/s – pico", "throughput.peakPerSec", 0],
  ["Máx. mensagens na fila", "queue.maxReady", 0],
  ["Tempo de drenagem após a carga (s)", "drainAfterLoadS", 1],
]
const FAIL_ROWS = [
  ["Erros retornados ao cliente", "failure.errorsDuringOutage", 0],
  ["Pedidos aceitos e perdidos", "db.lost", 0],
  ["1ª gravação após religar (s)", "failure.firstWriteAfterRestartS", 1],
  ["Tempo para normalizar após religar (s)", "failure.timeToNormalizeS", 1],
  ["Fila drenada após religar (s)", "failure.queueDrainedAfterRestartS", 1],
]

const lines = []
const p = (s = "") => lines.push(s)
p("# Resultados da etapa experimental — REST × RabbitMQ")
p()
p(
  `Gerado em ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC a partir de ${runs.length} execuções em \`${OUT.replace(ROOT, "")}/runs\`.`,
)
p(
  "Valores: média ± desvio-padrão das execuções de cada teste (n indicado em cada tabela).",
)
p()
p("## Ambiente")
p()
p(
  `- Máquina: ${machine.cpu ?? "?"}, ${machine.cores ?? "?"} núcleos, ${machine.memGiB ?? "?"} GiB RAM, macOS ${machine.os ?? "?"}`,
)
p(`- Docker ${machine.docker ?? "?"} (VM: ${machine.dockerVm ?? "?"})`)
p(
  "- Node.js 26.0.0 (imagem `node:26.0.0-alpine`), TypeScript 7.0.2, Fastify 5.10.0, Prisma 7.10.0 + `@prisma/adapter-pg`, PostgreSQL 18.4, RabbitMQ 4.3.5, k6 2.2.0",
)
p(
  "- Limites: cada serviço da aplicação 1 CPU / 512 MiB; PostgreSQL e RabbitMQ 2 CPUs / 1 GiB; pool de 10 conexões com o banco nos dois cenários; prefetch 10 no consumidor",
)
p(
  "- Fila durável e mensagens persistentes; publisher confirms; ack manual após gravar; `id` do pedido como chave primária (`ON CONFLICT DO NOTHING`)",
)
p()

for (const t of TESTS) {
  const r = sel("rest", t),
    m = sel("mq", t)
  p(`## ${TEST_NAMES[t] ?? t}`)
  p()
  p(`| Métrica | ${NAMES.rest} (n=${r.length}) | ${NAMES.mq} (n=${m.length}) |`)
  p("|---|---:|---:|")
  for (const [label, path, d] of ROWS) {
    if (path.startsWith("queue") && !m.length) continue
    p(`| ${label} | ${fmt(agg(r, path), d)} | ${fmt(agg(m, path), d)} |`)
  }
  if (t === "falha") {
    p()
    p("**Acoplamento (teste de falha)**")
    p()
    p(`| Métrica | ${NAMES.rest} | ${NAMES.mq} |`)
    p("|---|---:|---:|")
    for (const [label, path, d] of FAIL_ROWS)
      p(`| ${label} | ${fmt(agg(r, path), d)} | ${fmt(agg(m, path), d)} |`)
  }
  // recursos
  const containers = [
    ...new Set([...r, ...m].flatMap((x) => Object.keys(x.resources ?? {}))),
  ].sort()
  if (containers.length) {
    p()
    p(
      "**Uso de recursos durante a carga** (CPU em % de 1 núcleo; memória em MiB)",
    )
    p()
    p("| Contêiner | CPU média | CPU máx. | Memória média | Memória máx. |")
    p("|---|---:|---:|---:|---:|")
    for (const s of ["rest", "mq"])
      for (const c of containers) {
        const list = sel(s, t).filter((x) => x.resources?.[c])
        if (!list.length) continue
        p(
          `| ${s.toUpperCase()} · ${c} | ${fmt(agg(list, `resources.${c}.cpuAvgPct`))} | ${fmt(agg(list, `resources.${c}.cpuMaxPct`))} | ${fmt(agg(list, `resources.${c}.memAvgMiB`))} | ${fmt(agg(list, `resources.${c}.memMaxMiB`))} |`,
        )
      }
  }
  p()
}

// CSV com todas as execuções
const csvCols = [
  "id",
  "scenario",
  "test",
  "rep",
  ...ROWS.map((x) => x[1]),
  ...FAIL_ROWS.map((x) => x[1]),
]
const csv = [csvCols.join(",")].concat(
  runs
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => csvCols.map((c) => get(r, c) ?? "").join(",")),
)
writeFileSync(join(OUT, "resumo.csv"), csv.join("\n") + "\n")
writeFileSync(join(OUT, "RESULTADOS.md"), lines.join("\n"))
console.log(
  `escrito ${join(OUT, "RESULTADOS.md")} e resumo.csv (${runs.length} execuções)`,
)
