"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import Parser from "rss-parser";
import ibgeDict from "./ibge_dict.json";

const IBGE_CODES = new Set(Object.values(ibgeDict));
const IBGE_DICT_STR = JSON.stringify(ibgeDict);

// Delay entre chamadas para respeitar rate limit (15 RPM = 4s entre chamadas)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const fetchWeatherOSINT = action({
  args: {},
  handler: async (ctx: any) => {
    console.log("[INGESTOR] === Ciclo de ingestão iniciado ===");

    const parser = new Parser();
    let feed;
    try {
      feed = await parser.parseURL("https://www.defesacivil.sc.gov.br/categoria/aviso/feed/");
      console.log(`[INGESTOR] RSS: ${feed.items?.length || 0} itens`);
    } catch (e: any) {
      console.error("[INGESTOR] FALHA RSS:", e.message);
      return;
    }

    if (!feed.items || feed.items.length === 0) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("[INGESTOR] GEMINI_API_KEY ausente!");
      return;
    }

    const ai = new GoogleGenAI({ apiKey });

    const responseSchema: Schema = {
      type: Type.OBJECT,
      properties: {
        nivel_risco: {
          type: Type.STRING,
          description: "Classifique estritamente como: 'Baixo', 'Medio' ou 'Alto'",
        },
        cidades_afetadas_ibge: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          description: "Lista de códigos numéricos IBGE de 7 dígitos das cidades afetadas."
        },
        duracao_estimada_horas: {
          type: Type.INTEGER,
          description: "Tempo estimado em horas para expiração do risco. Se não mencionado, use 48."
        }
      }
    };

    const systemInstruction = `Você é o motor de extração de dados táticos do sistema Grid 48. Extraia de alertas da Defesa Civil de SC:

1. Nível de Risco: APENAS 'Baixo', 'Medio' ou 'Alto'.
2. Geolocalização (IBGE): Mapeie regiões mencionadas para cidades usando este dicionário (nome -> código IBGE):
${IBGE_DICT_STR}

Regras de mapeamento regional:
- "todas as regiões"/"todo estado" → 4205407, 4204202, 4209102, 4202404, 4204608, 4209300
- "Oeste"/"Extremo Oeste" → Chapecó(4204202), Xanxerê(4219507), São Miguel do Oeste(4217204)
- "Litoral"/"Litoral Norte" → Florianópolis(4205407), Itajaí(4208203), Joinville(4209102), Balneário Camboriú(4202008)
- "Vale do Itajaí" → Blumenau(4202404), Brusque(4202909), Itajaí(4208203), Gaspar(4205902)
- "Planalto"/"Planalto Sul" → Lages(4209300), Curitibanos(4204806), São Joaquim(4216503)
- "Grande Florianópolis" → Florianópolis(4205407), Palhoça(4211900), São José(4216602)

Retorne SEMPRE os valores numéricos do dicionário.
3. Duração (Horas): Se impreciso, use 48.`;

    let processados = 0;
    let pulados = 0;

    for (const item of feed.items) {
      const descricao = item.contentSnippet || item.content || item.description || "";
      if (!item.guid || descricao.length < 20) continue;

      const conteudoHash = "hash_" + Buffer.from(item.guid + descricao).toString('base64').substring(0, 32);

      // === ECONOMIA DE API: Verificar se já existe no banco com mesmo hash ===
      // Se existe e hash é igual, só renovar TTL sem chamar Gemini
      const existing = await ctx.runQuery(internal.queries.buscarPorGuid, { guid: item.guid });
      
      if (existing && existing.conteudo_hash === conteudoHash) {
        // Alerta já processado e conteúdo idêntico — renovar TTL sem gastar API
        const novoExpires = Math.floor(Date.now() + (48 * 60 * 60 * 1000));
        await ctx.runMutation(internal.mutations.refreshTTL, { 
          id: existing._id, 
          expiresAt: novoExpires 
        });
        pulados++;
        continue;
      }

      // === Item novo ou modificado — chamar Gemini ===
      try {
        console.log(`[INGESTOR] Gemini para: "${(item.title || '').substring(0, 50)}..."`);
        
        // Rate limit: esperar 1s entre chamadas Gemini (limite de 1k RPM)
        await sleep(1000);

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',  // Free tier: 5 RPM, 20 RPD
          contents: `Texto do Alerta da Defesa Civil de SC:\n\n${descricao}`,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.1,
          }
        });

        if (!response.text) continue;

        const rawJSON = response.text.replace(/```json/gi, "").replace(/```/g, "").trim();
        const payloadGemini = JSON.parse(rawJSON);

        const cidadesValidas = (payloadGemini.cidades_afetadas_ibge || [])
          .filter((c: number) => IBGE_CODES.has(c));

        if (cidadesValidas.length === 0) {
          cidadesValidas.push(4205407, 4204202, 4209102, 4202404, 4204608, 4209300);
        }

        const horas = payloadGemini.duracao_estimada_horas || 48;
        const dataExpiracao = Math.floor(Date.now() + (horas * 60 * 60 * 1000));

        await ctx.runMutation(internal.mutations.upsertAlerta, {
          guid: item.guid,
          titulo: item.title || "Sem título",
          link_oficial: item.link || "",
          data_publicacao: item.pubDate || new Date().toISOString(),
          nivel_risco: payloadGemini.nivel_risco || "Baixo",
          cidades_afetadas_ibge: cidadesValidas,
          expiresAt: dataExpiracao,
          conteudo_hash: conteudoHash
        });

        processados++;
      } catch(e: any) {
        console.error(`[INGESTOR] ERRO: ${e.message?.substring(0, 100)}`);
      }
    }

    console.log(`[INGESTOR] Fim: ${processados} novos, ${pulados} renovados (sem API)`);
  }
});
