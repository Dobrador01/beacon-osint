"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { GoogleGenAI, Type, Schema } from "@google/genai";
import Parser from "rss-parser";
import ibgeDict from "./ibge_dict.json";

// Injetando estritamente a base real de 295 municípios de Santa Catarina compilada do arquivo fonte.
const IBGE_DICT = JSON.stringify(ibgeDict);

// Janela de sobrevivência do alerta após sair do feed da Defesa Civil.
// Enquanto o item permanece no RSS, expiresAt é renovado a cada ciclo do cron.
const GRACE_PERIOD_MS = 6 * 60 * 60 * 1000;

const SOURCE_ID = "defesa_civil_sc";

export const fetchWeatherOSINT = action({
  args: {},
  handler: async (ctx: any) => {
    const runStartedAt = Date.now();
    let itemsProcessed = 0;
    let itemsFailed = 0;
    let runError: string | undefined;

    try {
      const parser = new Parser();
      const feed = await parser.parseURL("https://www.defesacivil.sc.gov.br/categoria/aviso/feed/");

      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const responseSchema: Schema = {
        type: Type.OBJECT,
        properties: {
          nivel_risco: {
            type: Type.STRING,
            description: "A classificação da gravidade deve ser estritamente escrita como: 'Baixo', 'Medio' ou 'Alto'",
          },
          cidades_afetadas_ibge: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: "Lista de códigos numéricos IBGE de 7 dígitos afetados. Limite-se APENAS à chaves do nosso dicionário."
          }
        }
      };

      const systemInstruction = `Você é o motor de extração de dados táticos do sistema Grid 48. Sua única função é ler o campo <description> de alertas da Defesa Civil de Santa Catarina via RSS e extrair os seguintes parâmetros:
1. Nível de Risco: Classifique o risco narrado APENAS como 'Baixo', 'Medio' ou 'Alto'.
2. Geolocalização (IBGE): Cruze o texto do alerta APENAS com as cidades deste dicionário JSON de monitoramento:
\${IBGE_DICT}
Retorne a lista contendo APENAS os Inteiros pertencentes ao Dicionário Base. Rejeite qualquer área exterior.
Não adicione limitantes de markdown, puro texto JSON de saida.`;

      for (const item of feed.items) {
        if (!item.guid || !item.description) continue;

        const conteudoHash = "hash_" + Buffer.from(item.guid + item.description).toString('base64').substring(0, 32);

        try {
          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: `Texto Extraído do Alerta: ${item.description}`,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: responseSchema,
              temperature: 0.1,
            }
          });

          if (!response.text) {
            itemsFailed++;
            continue;
          }

          let rawJSON = response.text;
          rawJSON = rawJSON.replace(/```json/gi, "");
          rawJSON = rawJSON.replace(/```/g, "");
          rawJSON = rawJSON.trim();

          const payloadGemini = JSON.parse(rawJSON);

          const expiresAt = Date.now() + GRACE_PERIOD_MS;

          await ctx.runMutation(internal.mutations.upsertAlerta, {
            guid: item.guid,
            titulo: item.title || "Sem título",
            link_oficial: item.link || "",
            data_publicacao: item.pubDate || new Date().toISOString(),
            nivel_risco: payloadGemini.nivel_risco || "Baixo",
            cidades_afetadas_ibge: payloadGemini.cidades_afetadas_ibge || [],
            expiresAt,
            conteudo_hash: conteudoHash
          });
          itemsProcessed++;

        } catch(e) {
          itemsFailed++;
          console.error(`Falha protetiva ativada no item ${item.guid}: `, e);
        }
      }
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e);
      console.error(`[OSINT] Falha no ciclo de ingestão: `, e);
    }

    await ctx.runMutation(internal.mutations.recordOsintHealth, {
      source: SOURCE_ID,
      lastRunAt: runStartedAt,
      success: !runError,
      lastError: runError,
      itemsProcessed,
      itemsFailed,
    });
  }
});
