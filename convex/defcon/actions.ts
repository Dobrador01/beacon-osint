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
// Rate limit: chamamos no máximo 1x por mudança de hash, então naturalmente
// economizamos os 5 RPM / 20 RPD do free tier. Sleep de 1s antes da chamada
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
    // Cache hit: explicação já existe pra esse hash.
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
      await sleep(1000); // mimetiza ingestor.ts — anti-rajada

      const ai = new GoogleGenAI({ apiKey });

      const evidencias = args.sinais_disparadores
        .map((d) => `• [${d.categoria.toUpperCase()}] ${d.evidencia}`)
        .join("\n");

      const prompt = `
Você é o Centro de Operações de Emergência (Grid 48), reportando o estado DEFCON
atual da Grande Florianópolis para o operador da dashboard.

NÍVEL GLOBAL: DEFCON ${args.nivel_global} (1=crítico, 5=tranquilo)
NÍVEIS POR CATEGORIA:
- Energia: DEFCON ${args.niveis_categoria.energia}
- Clima:   DEFCON ${args.niveis_categoria.clima}
- Mobilidade: DEFCON ${args.niveis_categoria.mobilidade}

SINAIS QUE DISPARARAM ESTE NÍVEL:
${evidencias || "(nenhum sinal crítico — estado nominal)"}

Escreva 2 a 3 frases curtas em português brasileiro explicando POR QUÊ estamos
neste nível. Tom: técnico, conciso, factual. NÃO repita os números — interprete-os.
NÃO ofereça recomendações de ação a menos que o nível seja 1 ou 2.
NÃO use markdown. Apenas o texto puro.
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
      // Fallback genérico — pelo menos a UI mostra alguma coisa.
      await ctx.runMutation(internal.defcon.mutations.saveExplicacao, {
        inputs_hash: args.inputs_hash,
        texto: `DEFCON ${args.nivel_global} ativo — explicação textual indisponível no momento.`,
        modelo: "fallback",
      });
    }
  },
});
