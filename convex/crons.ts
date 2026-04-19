import { cronJobs } from "convex/server";
import { api, internal } from "./_generated/api";

const crons = cronJobs();

// Checagem reincidente a cada 15 minutos na Defesa Civil.
// O Upsert Idempotente do Action garante que tokens da I.A não sejam gastos inutilmente.
crons.interval(
  "fetch-defesa-civil",
  { minutes: 15 }, 
  api.ingestor.fetchWeatherOSINT,
);

// Garbage Collector: Expurgo físico de dados expirados diariamente para poupar banco.
crons.interval(
  "gc-alertas-expirados",
  { hours: 24 },
  internal.mutations.deleteExpiredAlerts
);

export default crons;
