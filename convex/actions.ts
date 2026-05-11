import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { GoogleGenAI } from "@google/genai";

// Enums mapped from Protobuf (proto/grid48/sitrep.proto)
const CATEGORIAS = {
  1: "ENERGIA",
  2: "CLIMA",
  3: "MOBILIDADE"
};

const LOCALIDADES = {
  1: "FLORIANOPOLIS",
  2: "SAO_JOSE",
  3: "PALHOCA",
  4: "BIGUACU"
};

export const processSitrep = internalAction({
  args: {
    request_id: v.string(),
    categoria: v.number(),
    localidade: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("Missing GEMINI_API_KEY environment variable");

      const catName = CATEGORIAS[args.categoria as keyof typeof CATEGORIAS] || "GERAL";
      const locName = LOCALIDADES[args.localidade as keyof typeof LOCALIDADES] || "REGIAO";

      const ai = new GoogleGenAI({ apiKey });

      const prompt = `
        Atue como o Centro de Operações de Emergência (Grid 48).
        Analise a situação de ${catName} em ${locName}.
        Baseado nos padrões de crise climática de Santa Catarina, retorne um ÚNICO NÚMERO INTEIRO entre 0 e 100
        representando o nível de criticidade (0 = Normal, 100 = Colapso total).
        Não escreva nenhum outro texto. Apenas o número.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const text = response.text || "0";
      const valor = parseInt(text.trim(), 10);
      const safeValor = isNaN(valor) ? 0 : Math.min(100, Math.max(0, valor));

      // Salva o resultado de volta no banco, marcando o status como "ready"
      await ctx.runMutation(internal.mutations.completeSitrep, {
        request_id: args.request_id,
        resposta_valor: safeValor,
        ttl_seconds: 3600 // Válido por 1 hora
      });

      console.log(`[SITREP ACTION] Processed request ${args.request_id}: Valor = ${safeValor}`);
    } catch (error) {
      console.error("[SITREP ACTION] Failed to process:", error);
      // Fallback on error so the node doesn't wait forever
      await ctx.runMutation(internal.mutations.completeSitrep, {
        request_id: args.request_id,
        resposta_valor: 999, // 999 = Código de Erro
        ttl_seconds: 60
      });
    }
  },
});
