import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, arr) =>
        a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc,
      [],
    ),
)
const REPS = Number(args.reps ?? 3)
const TESTS = (args.tests ?? "baixa,crescente,pico,falha").split(",")
const SCENARIOS = (args.scenarios ?? "rest,mq").split(",")
const SCALE = Number(args.scale ?? 1)
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const OUT = resolve(ROOT, args.out ?? "results")
const PROJECT = "etapa-experimental"
const NETWORK = `${PROJECT}_default`
const FAIL_AT_S = 60 * SCALE,
  FAIL_FOR_S = 60 * SCALE
const DRAIN_TIMEOUT_MS = 20 * 60_000

mkdirSync(join(OUT, "runs"), { recursive: true })
mkdirSync(join(OUT, "raw"), { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m)
const sh = (cmd, a, opts = {}) =>
  execFileSync(cmd, a, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim()
const compose = (...a) =>
  sh("docker", ["compose", "--profile", "rest", "--profile", "mq", ...a])
const psql = (sql) =>
  sh("docker", [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "app",
    "-d",
    "pedidos",
    "-AtF",
    "|",
    "-c",
    sql,
  ])

const SERVICES = {
  rest: { entrada: "rest-entrada", proc: "rest-processamento", infra: [] },
  mq: { entrada: "mq-entrada", proc: "mq-processamento", infra: ["rabbitmq"] },
}

function queueDepth() {
  try {
    const out = sh("docker", [
      "compose",
      "exec",
      "-T",
      "rabbitmq",
      "rabbitmqctl",
      "-q",
      "list_queues",
      "name",
      "messages_ready",
      "messages_unacknowledged",
      "--no-table-headers",
    ])
    const line = out.split("\n").find((l) => l.startsWith("orders"))
    if (!line) return { ready: 0, unacked: 0 }
    const [, ready, unacked] = line.split(/\s+/).map(Number)
    return { ready, unacked }
  } catch {
    return null
  }
}

// ---------- amostragem de CPU/memória (docker stats em streaming) ----------
function startStatsSampler() {
  const samples = []
  const p = spawn("docker", ["stats", "--format", "{{json .}}"], { cwd: ROOT })
  let buf = ""
  p.stdout.on("data", (chunk) => {
    buf += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "\n")
    const lines = buf.split("\n")
    buf = lines.pop()
    const t = Date.now()
    for (const l of lines) {
      const s = l.trim()
      if (!s.startsWith("{")) continue
      try {
        const j = JSON.parse(s)
        if (!j.Name?.startsWith(PROJECT)) continue
        const mem = /([\d.]+)\s*([KMG]i?B)/.exec(j.MemUsage)
        const mult =
          { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[
            mem?.[2]
          ] ?? 1
        samples.push({
          t,
          name: j.Name.replace(`${PROJECT}-`, "").replace(/-1$/, ""),
          cpu: parseFloat(j.CPUPerc),
          memMiB: mem ? parseFloat(mem[1]) * mult : 0,
        })
      } catch {}
    }
  })
  return {
    stop: () => {
      p.kill()
      return samples
    },
  }
}

function startQueueSampler(enabled) {
  const samples = []
  let on = enabled
  ;(async () => {
    while (on) {
      const q = queueDepth()
      if (q) samples.push({ t: Date.now(), ...q })
      await sleep(1000)
    }
  })()
  return {
    stop: () => {
      on = false
      return samples
    },
  }
}

// ---------- ambiente ----------
async function prepareScenario(scenario) {
  const other = scenario === "rest" ? "mq" : "rest"
  const o = SERVICES[other]
  try {
    compose("stop", o.entrada, o.proc, ...o.infra)
  } catch {}
  const s = SERVICES[scenario]
  sh(
    "docker",
    [
      "compose",
      "--profile",
      scenario,
      "up",
      "-d",
      "--wait",
      "postgres",
      ...s.infra,
      s.entrada,
      s.proc,
    ],
    { timeout: 600_000 },
  )
}

async function resetState(scenario) {
  const s = SERVICES[scenario]
  if (scenario === "mq")
    sh("docker", [
      "compose",
      "exec",
      "-T",
      "rabbitmq",
      "rabbitmqctl",
      "-q",
      "purge_queue",
      "orders",
    ])
  psql("TRUNCATE orders;")
  psql("VACUUM ANALYZE orders;")
  compose("restart", s.entrada, s.proc)
  await waitHealthy(s.entrada)
  await sleep(2000)
}

async function waitHealthy(svc) {
  for (let i = 0; i < 120; i++) {
    try {
      sh("docker", [
        "run",
        "--rm",
        "--network",
        NETWORK,
        "curlimages/curl:8.11.1",
        "-sf",
        `http://${svc}:3000/health`,
      ])
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`${svc} não ficou saudável`)
}

function runK6(scenario, test, summaryFile) {
  const target = `http://${SERVICES[scenario].entrada}:3000/orders`
  return new Promise((res, rej) => {
    const p = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        NETWORK,
        "-v",
        `${join(ROOT, "k6")}:/scripts:ro`,
        "-v",
        `${join(OUT, "raw")}:/results`,
        "grafana/k6:2.2.0",
        "run",
        "--quiet",
        "--no-color",
        "-e",
        `TEST=${test}`,
        "-e",
        `TARGET=${target}`,
        "-e",
        `SCALE=${SCALE}`,
        "-e",
        `SUMMARY=/results/${summaryFile}`,
        "/scripts/teste.js",
      ],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    )
    let err = ""
    p.stderr.on("data", (d) => {
      err += d
    })
    p.stdout.on("data", () => {})
    p.on("close", (code) =>
      code === 0 || code === 99
        ? res(code)
        : rej(new Error(`k6 saiu com ${code}: ${err.slice(-2000)}`)),
    )
  })
}

// ---------- métricas no banco ----------
function dbStats(fromMs, toMs) {
  const where = fromMs
    ? `WHERE received_at >= to_timestamp(${fromMs / 1000}) AND received_at < to_timestamp(${toMs / 1000})`
    : ""
  const [row] = psql(`
    WITH t AS (SELECT received_at, processed_at, EXTRACT(EPOCH FROM processed_at - received_at)*1000 AS ms FROM orders ${where})
    SELECT count(*), round(avg(ms)::numeric,2),
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::numeric,2),
           round(percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::numeric,2),
           round(percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)::numeric,2),
           round(max(ms)::numeric,2),
           extract(epoch from min(received_at))*1000, extract(epoch from max(processed_at))*1000
    FROM t;`).split("\n")
  const [count, avg, med, p95, p99, max, firstRecv, lastProc] = row
    .split("|")
    .map((v) => (v === "" ? null : Number(v)))
  return { count, avg, med, p95, p99, max, firstRecv, lastProc }
}

function throughput() {
  const rows = psql(
    `SELECT extract(epoch from date_trunc('second', processed_at))::bigint, count(*) FROM orders GROUP BY 1 ORDER BY 1;`,
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|").map(Number))
  if (!rows.length) return { peakPerSec: 0, avgPerSec: 0, series: [] }
  const span = rows.at(-1)[0] - rows[0][0] + 1
  const total = rows.reduce((a, r) => a + r[1], 0)
  return {
    peakPerSec: Math.max(...rows.map((r) => r[1])),
    avgPerSec: +(total / span).toFixed(2),
    series: rows,
  }
}

function normalization(failStart, failEnd, rate) {
  const base = dbStats(failStart - 50_000, failStart)
  const limit = Math.max(2 * (base.p95 ?? 0), (base.p95 ?? 0) + 50)
  const rows = psql(`
    SELECT extract(epoch from date_trunc('second', processed_at))::bigint s, count(*),
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM processed_at - received_at)*1000)
    FROM orders WHERE processed_at >= to_timestamp(${failEnd / 1000}) GROUP BY 1 ORDER BY 1;`)
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|").map(Number))
  const firstWrite = rows[0] ? rows[0][0] * 1000 : null
  const ok = rows.find(([, c, p]) => p <= limit && c >= 0.9 * rate)
  return {
    baselineP95: base.p95,
    limitMs: +limit.toFixed(2),
    firstWriteAfterRestartS: firstWrite
      ? +((firstWrite - failEnd) / 1000).toFixed(1)
      : null,
    timeToNormalizeS: ok ? +((ok[0] * 1000 - failEnd) / 1000).toFixed(1) : null,
  }
}

function summarizeResources(samples, from, to) {
  const out = {}
  for (const s of samples.filter((x) => x.t >= from && x.t <= to)) {
    const o = (out[s.name] ??= {
      n: 0,
      cpuSum: 0,
      cpuMax: 0,
      memSum: 0,
      memMax: 0,
    })
    o.n++
    o.cpuSum += s.cpu
    o.cpuMax = Math.max(o.cpuMax, s.cpu)
    o.memSum += s.memMiB
    o.memMax = Math.max(o.memMax, s.memMiB)
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, o]) => [
      k,
      {
        cpuAvgPct: +(o.cpuSum / o.n).toFixed(1),
        cpuMaxPct: +o.cpuMax.toFixed(1),
        memAvgMiB: +(o.memSum / o.n).toFixed(1),
        memMaxMiB: +o.memMax.toFixed(1),
      },
    ]),
  )
}

const metric = (summary, name, stat) =>
  summary.metrics?.[name]?.values?.[stat] ?? null

async function runOnce(scenario, test, rep) {
  const id = `${scenario}-${test}-${rep}`
  const file = join(OUT, "runs", `${id}.json`)
  if (existsSync(file)) {
    log(`pulando ${id} (já existe)`)
    return
  }
  log(`▶ ${id}`)
  await prepareScenario(scenario)
  await resetState(scenario)

  const stats = startStatsSampler()
  const queue = startQueueSampler(scenario === "mq")
  const failure = {}
  const t0 = Date.now()
  const timers = []
  if (test === "falha") {
    const proc = SERVICES[scenario].proc
    timers.push(
      setTimeout(
        () => {
          failure.stoppedAt = Date.now()
          try {
            compose("kill", proc)
          } catch (e) {
            log("erro kill", e.message)
          }
          log(`  ✖ ${proc} desligado`)
        },
        FAIL_AT_S * 1000 + 1500,
      ),
    )
    timers.push(
      setTimeout(
        () => {
          try {
            compose("start", proc)
          } catch (e) {
            log("erro start", e.message)
          }
          failure.startedAt = Date.now()
          log(`  ✔ ${proc} religado`)
        },
        (FAIL_AT_S + FAIL_FOR_S) * 1000 + 1500,
      ),
    )
  }
  const summaryFile = `${id}.k6.json`
  await runK6(scenario, test, summaryFile)
  const t1 = Date.now()
  timers.forEach(clearTimeout)

  let drainedAt = t1,
    lastCount = -1,
    stable = 0
  const maxQ = { ready: 0 }
  while (Date.now() - t1 < DRAIN_TIMEOUT_MS) {
    const q = scenario === "mq" ? queueDepth() : { ready: 0, unacked: 0 }
    const c = Number(psql("SELECT count(*) FROM orders;"))
    if (q && q.ready === 0 && q.unacked === 0 && c === lastCount) {
      if (++stable >= 2) break
    } else stable = 0
    lastCount = c
    drainedAt = Date.now()
    await sleep(1000)
  }
  const t2 = Date.now()
  const res = stats.stop(),
    qs = queue.stop()

  const { readFileSync } = await import("node:fs")
  const k6 = JSON.parse(readFileSync(join(OUT, "raw", summaryFile), "utf8"))
  const sent = metric(k6, "http_reqs", "count")
  const accepted = metric(k6, "pedidos_aceitos", "count") ?? 0
  const rejected = metric(k6, "pedidos_rejeitados", "count") ?? 0
  const db = dbStats()
  const tp = throughput()
  const result = {
    id,
    scenario,
    test,
    rep,
    scale: SCALE,
    startedAt: new Date(t0).toISOString(),
    loadDurationS: +((t1 - t0) / 1000).toFixed(1),
    drainAfterLoadS: +((drainedAt - t1) / 1000).toFixed(1),
    k6: {
      sent,
      accepted,
      rejected,
      dropped: metric(k6, "dropped_iterations", "count") ?? 0,
      errorRatePct: sent ? +((rejected / sent) * 100).toFixed(3) : null,
      respAvgMs: metric(k6, "http_req_duration", "avg"),
      respMedMs: metric(k6, "http_req_duration", "med"),
      respP95Ms: metric(k6, "http_req_duration", "p(95)"),
      respP99Ms: metric(k6, "http_req_duration", "p(99)"),
      respMaxMs: metric(k6, "http_req_duration", "max"),
      achievedRps: metric(k6, "http_reqs", "rate"),
    },
    db: { ...db, lost: Math.max(0, accepted - db.count) },
    throughput: { peakPerSec: tp.peakPerSec, avgPerSec: tp.avgPerSec },
    queue:
      scenario === "mq"
        ? {
            maxReady: Math.max(0, ...qs.map((q) => q.ready)),
            samples: qs.map((q) => [q.t - t0, q.ready, q.unacked]),
          }
        : null,
    resources: summarizeResources(res, t0, t1),
    series: { writesPerSec: tp.series.map(([s, c]) => [s * 1000 - t0, c]) },
  }
  if (test === "falha" && failure.startedAt) {
    result.failure = {
      stoppedAtS: +((failure.stoppedAt - t0) / 1000).toFixed(1),
      restartedAtS: +((failure.startedAt - t0) / 1000).toFixed(1),
      ...normalization(failure.stoppedAt, failure.startedAt, 100),
      errorsDuringOutage: rejected,
    }
    if (scenario === "mq") {
      const after = qs.filter((q) => q.t >= failure.startedAt)
      const drained = after.find((q) => q.ready <= 20)
      result.failure.queueDrainedAfterRestartS = drained
        ? +((drained.t - failure.startedAt) / 1000).toFixed(1)
        : null
    }
  }
  writeFileSync(file, JSON.stringify(result, null, 2))
  log(
    `  ✓ ${id}: enviados=${sent} aceitos=${accepted} erros=${result.k6.errorRatePct}% gravados=${db.count} ` +
      `resp p95=${result.k6.respP95Ms?.toFixed(1)}ms e2e p95=${db.p95}ms drenagem=${result.drainAfterLoadS}s`,
  )
}

const machine = {
  cpu: sh("sysctl", ["-n", "machdep.cpu.brand_string"]),
  cores: Number(sh("sysctl", ["-n", "hw.ncpu"])),
  memGiB: Number(sh("sysctl", ["-n", "hw.memsize"])) / 2 ** 30,
  os: sh("sw_vers", ["-productVersion"]),
  docker: sh("docker", ["version", "--format", "{{.Server.Version}}"]),
  dockerVm: sh("docker", [
    "info",
    "--format",
    "{{.NCPU}} CPUs, {{.MemTotal}} bytes",
  ]),
}
writeFileSync(join(OUT, "machine.json"), JSON.stringify(machine, null, 2))
log("máquina:", JSON.stringify(machine))

for (let rep = 1; rep <= REPS; rep++)
  for (const test of TESTS)
    for (const scenario of rep % 2 ? SCENARIOS : [...SCENARIOS].reverse())
      await runOnce(scenario, test, rep)
log("fim")
