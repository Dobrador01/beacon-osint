import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Consolidated schema: hosts both the Beacon OSINT pipeline (alertas_rss) and
// the Grid 48 Gateway domain (telemetry + sitrep_queue). Tables are disjoint
// — no foreign keys cross the boundary — so future re-separation is trivial.
export default defineSchema({
  // ── Beacon OSINT (Defesa Civil RSS → Gemini → upsert) ──────────────────
  alertas_rss: defineTable({
    guid: v.string(),
    titulo: v.string(),
    link_oficial: v.string(),
    data_publicacao: v.string(),
    nivel_risco: v.string(),
    cidades_afetadas_ibge: v.array(v.number()),
    expiresAt: v.number(),
    conteudo_hash: v.string(),
  })
    .index("by_guid", ["guid"])
    .index("by_expiresAt", ["expiresAt"]),

  // ── Grid 48 Gateway (telemetria LoRa + SITREP IA) ──────────────────────
  telemetry: defineTable({
    node_id: v.string(),
    packet_id: v.number(),
    timestamp: v.number(),
    lat: v.number(),
    lon: v.number(),
    bitmask_status: v.number(),
    rssi: v.optional(v.number()),
    battery_level: v.optional(v.number()),
  })
    .index("by_node_packet", ["node_id", "packet_id"])
    .index("by_timestamp", ["timestamp"]),

  sitrep_queue: defineTable({
    request_id: v.string(),
    categoria: v.number(),  // CategoriaSitrep enum (1=ENERGIA, 2=CLIMA, 3=MOBILIDADE)
    localidade: v.number(), // LocalidadeMacro enum (1=Floripa, 2=Sao Jose, ...)
    status: v.string(),     // "pending" | "ready" | "expired"
    resposta_valor: v.optional(v.number()),
    ttl_seconds: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
  })
    .index("by_request_id", ["request_id"])
    .index("by_status", ["status"]),

  // ── Celesc — Snapshot atual (estado mutável, latest por chave) ─────────
  // O frontend reporta a cada refresh (services/celesc.ts → reportCelescSnapshot).
  // Uma row por (ibge_municipio, bairro?) — bairro=null representa o agregado
  // do município. ~300 rows totais em pico. É lido por recomputeDefcon.
  celesc_state: defineTable({
    ibge_municipio: v.number(),
    bairro: v.optional(v.string()),         // undefined = row agregada do município
    municipio_nome: v.string(),
    ucs_afetadas: v.number(),
    ucs_total_municipio: v.optional(v.number()), // só preenchido em rows agregadas
    tendencia: v.optional(v.string()),       // "ESTÁVEL"|"PIORANDO"|"MELHORANDO"
    atualizado_em: v.number(),
    ultimo_heartbeat_em: v.number(),         // pra decidir se grava heartbeat (>6h)
  })
    .index("by_chave", ["ibge_municipio", "bairro"])
    .index("by_municipio", ["ibge_municipio"]),

  // ── Celesc — Histórico append-only (timeline, 90d retention) ───────────
  // SÓ MUNICÍPIO (sem bairro — decisão de design: timeline futura usa mapa
  // .gl que renderiza por município). Reduz volume drasticamente.
  // kind: "change"   = mudou ucs_afetadas ou tendencia
  //       "heartbeat" = sem mudança, mas passou >6h da última gravação (prova
  //                     que pipeline não morreu)
  //       "resolved"  = município sumiu do snapshot (ucs_afetadas = 0)
  celesc_history: defineTable({
    ts: v.number(),
    ibge_municipio: v.number(),
    municipio_nome: v.string(),
    ucs_afetadas: v.number(),
    ucs_total_municipio: v.optional(v.number()),
    tendencia: v.optional(v.string()),
    kind: v.union(v.literal("change"), v.literal("heartbeat"), v.literal("resolved")),
  })
    .index("by_ts", ["ts"])
    .index("by_municipio_ts", ["ibge_municipio", "ts"]),

  // ── DEFCON — Configuração (singleton, editada pela UI Settings) ────────
  // Parâmetros ajustáveis pelo usuário enquanto refina os gatilhos.
  // Ausente = usar defaults hard-coded (defcon/config.ts:DEFAULT_CONFIG).
  defcon_config: defineTable({
    singleton: v.literal("global"),
    // Localidades pessoais (casa/trabalho) — gatilho fino por bairro absoluto
    localidades_foco: v.array(v.object({
      label: v.string(),
      ibge_municipio: v.number(),
      bairro_celesc: v.string(),  // string EXATA como aparece no widget Celesc
    })),
    // Municípios secundários — gatilho amplo por % UC sem luz
    municipios_secundarios: v.array(v.number()), // IBGEs (default: SJ, Floripa, Palhoça)
    // Municípios da Grande Florianópolis (regra 6.1) — alerta Defesa Civil
    grande_florianopolis: v.array(v.number()),
    // Thresholds parametrizados
    threshold_bairro_ucs: v.number(),     // 6.2: UCs absoluto no bairro foco → DEFCON
    nivel_bairro_critico: v.number(),     // 6.2: nível DEFCON quando bate (default 3)
    threshold_municipio_pct: v.number(),  // 6.3: % UCs no município secundário (0-100)
    nivel_municipio_alerta: v.number(),   // 6.3: nível DEFCON quando bate (default 4)
    nivel_alerta_alto_grande_floripa: v.number(), // 6.1: nível quando alerta Alto cobrir Grande Floripa (default 3)
    atualizado_em: v.number(),
  })
    .index("by_singleton", ["singleton"]),

  // ── DEFCON — Estado Operacional Agregado (singleton) ───────────────────
  // Convenção militar: 1 = mais crítico, 5 = tranquilo. O nível global é
  // calculado por regras determinísticas em convex/defcon/rules.ts; o Gemini
  // só gera a explicação textual (cache por inputs_hash). Recompute reativo
  // disparado por upsertAlerta / ingestTelemetry / completeSitrep / reportCelescSnapshot.
  defcon_status: defineTable({
    singleton: v.literal("global"), // discriminador único — sempre "global"
    nivel_global: v.number(),       // 1..5
    niveis_categoria: v.object({
      energia: v.number(),
      clima: v.number(),
      mobilidade: v.number(),
    }),
    inputs_hash: v.string(),        // hash determinístico dos sinais agregados
    sinais_disparadores: v.array(v.object({
      categoria: v.string(),        // "energia" | "clima" | "mobilidade"
      regra_id: v.string(),
      evidencia: v.string(),
    })),
    explicacao: v.optional(v.object({
      texto: v.string(),
      gerada_em: v.number(),
      inputs_hash: v.string(),       // bate com o inputs_hash principal quando fresca
      modelo: v.string(),
    })),
    nivel_anterior: v.optional(v.number()),
    recomputado_em: v.number(),
    ultima_mudanca_em: v.number(),
  })
    .index("by_singleton", ["singleton"]),
});
