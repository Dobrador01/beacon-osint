import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

// ── Beacon OSINT ────────────────────────────────────────────────────────
// Checagem reincidente a cada 15 minutos na Defesa Civil.
// O Upsert Idempotente do Action garante que tokens da I.A não sejam gastos inutilmente.
crons.interval(
  "fetch-defesa-civil",
  { minutes: 15 },
  api.ingestor.fetchWeatherOSINT,
);

// Garbage Collector: Expurgo físico de alertas RSS expirados diariamente.
crons.interval(
  "gc-alertas-expirados",
  { hours: 24 },
  internal.mutations.deleteExpiredAlerts
);

// ── Grid 48 Gateway ─────────────────────────────────────────────────────
// Sweep expired sitrep_queue rows every hour. Each row has a 5 min TTL
// (see createSitrepRequest), so anything older than that is dead weight.
crons.interval(
  "gc-sitrep-queue",
  { hours: 1 },
  internal.mutations.gcSitrepQueue,
);

// ── Celesc — Retention 90d do histórico ────────────────────────────────
// Roda diariamente. A mutation processa em batches de 200 e auto-agenda
// continuação se atingir o limite (caso de pico/backlog).
crons.interval(
  "gc-celesc-history",
  { hours: 24 },
  internal.celesc.mutations.gcCelescHistory,
);

export default crons;
