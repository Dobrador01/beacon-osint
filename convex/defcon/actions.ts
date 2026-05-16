import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { GoogleGenAI } from "@google/genai";

// ═══════════════════════════════════════════════════════════════════════════
// DEFCON — Action que gera a explicação textual via Gemini
// ═══════════════════════════════════════════════════════════════════════════
//
// Roda no runtime padrão Convex (NÃO usa "use node" — `@google/genai` funciona
// no isolate V8). Padrão alinhado com convex/actions.ts:processSitrep.
//
// Cache: a chave é `inputs_hash`. Antes de chamar Gemini, re-checamos o hash
// atual (anti-corrida). Após gerar, `saveExplicacao` valida o hash de novo
// antes do patch — defesa em profundidade contra estado stale.
//
// Args contextuais (alertas_top, contexto_celesc) NÃO entram no hash —
// alimentam só o prompt pra ele poder ser concreto ("alerta de chuva forte"
// em vez de "alto risco genérico"). Hash continua estável e cache eficiente.
//
// Rate limit: chamamos no máximo 1x por mudança de hash. Sleep de 1s antes
// só pra mimetizar o pattern do ingestor (defesa contra rajadas paralelas).
// ═══════════════════════════════════════════════════════════════════════════

const MODELO = "gemini-2.5-flash";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const explainDefcon = internalAction({
  args: {
    inputs_hash: v.string(),
    nivel_global: v.number(),
    niveis_categoria: v.object({
      energia: v.number(),
      clima: v.number(),
      mobilidade: v.number(),
    }),
    sinais_disparadores: v.array(
      v.object({
        categoria: v.string(),
        regra_id: v.string(),
        evidencia: v.string(),
      }),
    ),
    // Contexto extra — alimenta o prompt mas NÃO afeta hash.
    alertas_top: v.array(
      v.object({
        titulo: v.string(),
        nivel_risco: v.string(),
        cidades_count: v.number(),
      }),
    ),
    contexto_celesc: v.object({
      bairros_foco: v.array(
        v.object({
          label: v.string(),
          bairro_celesc: v.string(),
          ibge_municipio: v.number(),
          ucs_afetadas: v.number(),
        }),
      ),
      municipios_secundarios: v.array(
        v.object({
          ibge_municipio: v.number(),
          municipio_nome: v.string(),
          ucs_afetadas: v.number(),
          ucs_total: v.union(v.number(), v.null()),
          pct: v.union(v.number(), v.null()),
        }),
      ),
    }),
  },
  handler: async (ctx, args) => {
    // ── Anti-corrida: re-checar hash antes de chamar Gemini ──────────────
    const row = await ctx.runQuery(internal.defcon.queries._getDefconRowInternal, {});
    if (!row) {
      console.log("[DEFCON] explainDefcon: row inexistente, abortando");
      return;
    }
    if (row.inputs_hash !== args.inputs_hash) {
      console.log(
        `[DEFCON] explainDefcon: hash mudou (${args.inputs_hash} → ${row.inputs_hash}), descartando`,
      );
      return;
    }
    if (row.explicacao && row.explicacao.inputs_hash === args.inputs_hash) {
      console.log(`[DEFCON] explainDefcon: cache hit para hash=${args.inputs_hash}`);
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[DEFCON] GEMINI_API_KEY ausente — salvando fallback");
      await ctx.runMutation(internal.defcon.mutations.saveExplicacao, {
        inputs_hash: args.inputs_hash,
        texto: `DEFCON ${args.nivel_global} (explicação indisponível: chave Gemini ausente).`,
        modelo: "fallback",
      });
      return;
    }

    try {
      await sleep(1000);

      const ai = new GoogleGenAI({ apiKey });

      // ── Monta blocos do prompt com dados concretos ─────────────────────
      const causasBlock = args.sinais_disparadores.length > 0
        ? args.sinais_disparadores
            .map((d) => `• [${d.categoria.toUpperCase()}] ${d.evidencia}`)
            .join("\n")
        : "(nenhuma regra disparada — estado nominal)";

      const alertasBlock = args.alertas_top.length > 0
        ? args.alertas_top
            .map((a) =>
              `• "${a.titulo}" (${a.nivel_risco}, cobrindo ${a.cidades_count} cidade${a.cidades_count === 1 ? "" : "s"})`,
            )
            .join("\n")
        : "(sem alertas ativos da Defesa Civil)";

      const bairrosBlock = args.contexto_celesc.bairros_foco.length > 0
        ? args.contexto_celesc.bairros_foco
            .map((b) => `• ${b.label} (${b.bairro_celesc}): ${b.ucs_afetadas} UCs sem luz`)
            .join("\n")
        : "(nenhum bairro foco cadastrado)";

      const municipiosBlock = args.contexto_celesc.municipios_secundarios.length > 0
        ? args.contexto_celesc.municipios_secundarios
            .map((m) => {
              const pctStr = m.pct !== null ? `${m.pct.toFixed(2)}%` : "n/d";
              return `• ${m.municipio_nome}: ${m.ucs_afetadas} UCs (${pctStr})`;
            })
            .join("\n")
        : "(sem dados de municípios secundários)";

      const prompt = `
Você é o Centro de Operações de Emergência (Grid 48), reportando o estado DEFCON
atual da Grande Florianópolis para o operador da dashboard.

ESTADO ATUAL:
- DEFCON global: ${args.nivel_global}
- DEFCON por categoria: Energia ${args.niveis_categoria.energia}, Clima ${args.niveis_categoria.clima}, Mobilidade ${args.niveis_categoria.mobilidade}

CAUSAS DIRETAS (regras que dispararam o nível atual):
${causasBlock}

ALERTAS ATIVOS DA DEFESA CIVIL (top 2 por gravidade — use o título literal pra extrair a natureza do evento):
${alertasBlock}

CONTEXTO CELESC (bairros foco do operador):
${bairrosBlock}

CONTEXTO CELESC (municípios da região monitorada):
${municipiosBlock}

REGRAS DE ESCRITA:
1. Comece pela CAUSA mais crítica do nível atual, citando o dado específico. Se for um alerta da Defesa Civil, extraia a natureza do evento do TÍTULO LITERAL (ex: "chuvas fortes", "ventos intensos", "deslizamentos") — NÃO invente adjetivos sensacionalistas. Mencione no máximo os 2 alertas mais graves.
2. Se houver CONTRASTE relevante (categoria crítica em ${args.nivel_global} + outra categoria estável), cite os números das duas em UMA frase curta. Ex: "Celesc estável com 0.20% UCs afetadas em São José". Se NÃO houver contraste (tudo crítico OU tudo tranquilo), pule essa frase.
3. NÃO repita o número DEFCON global ("DEFCON ${args.nivel_global}") — o operador já vê na tela.
4. NÃO use frases genéricas tipo "indica um estado de atenção", "demanda monitoramento", "situação requer cautela".
5. NÃO ofereça recomendações de ação a menos que o nível seja 1 ou 2.
6. Use "DEFCON" sempre em maiúsculas.
7. Máximo 2 frases. Português brasileiro. Tom factual, sem alarmismo. Sem markdown.
      `.trim();

      const response = await ai.models.generateContent({
        model: MODELO,
        contents: prompt,
      });

      const texto = (response.text || "").trim();
      if (!texto) {
        throw new Error("Gemini retornou texto vazio");
      }

      await ctx.runMutation(internal.defcon.mutations.saveExplicacao, {
        inputs_hash: args.inputs_hash,
        texto,
        modelo: MODELO,
      });
      console.log(`[DEFCON] explicação salva para hash=${args.inputs_hash}`);
    } catch (e: any) {
      console.error(`[DEFCON] Falha Gemini: ${e?.message ?? e}`);
      await ctx.runMutation(internal.defcon.mutations.saveExplicacao, {
        inputs_hash: args.inputs_hash,
        texto: `DEFCON ${args.nivel_global} ativo — explicação textual indisponível no momento.`,
        modelo: "fallback",
      });
    }
  },
});
