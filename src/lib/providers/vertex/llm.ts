/**
 * Adaptador Gemini (Vertex AI) para parseBrief -> PlanJSON.
 * Usa generateContent con responseMimeType=application/json + responseSchema.
 */
import { vertexBaseUrl, assertVertexConfig, resolveModel } from "../../config";
import { PARSER_RESPONSE_SCHEMA, PARSER_SYSTEM_PROMPT } from "../../prompts";
import { validatePlan, type ProjectPlan } from "../../schema";
import type { LlmProvider } from "../types";
import { authHeaders } from "./auth";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: unknown;
}

export class VertexLlmProvider implements LlmProvider {
  async parseBrief(text: string, opts?: { model?: string }): Promise<ProjectPlan> {
    assertVertexConfig();
    const model = resolveModel("llm", opts?.model);
    const url = `${vertexBaseUrl()}/${model}:generateContent`;

    const body = {
      systemInstruction: {
        role: "system",
        parts: [{ text: PARSER_SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: `BRIEF:\n${text}` }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
        // responseSchema fuerza el shape del JSON.
        responseSchema: PARSER_RESPONSE_SCHEMA,
        maxOutputTokens: 8192,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Gemini parseBrief fallo (${res.status}): ${errText.slice(0, 500)}`
      );
    }

    const data = (await res.json()) as GeminiResponse;
    const raw = data.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? "")
      .join("");

    if (!raw) {
      throw new Error(
        "Gemini no devolvio contenido. Revisá el modelo/region o el brief."
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Por si vino envuelto en markdown a pesar del responseMimeType.
      const cleaned = raw.replace(/^```json\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    }

    const validation = validatePlan(parsed);
    if (!validation.ok) {
      const detail = validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      throw new Error(
        `El plan devuelto por Gemini no paso la validacion Zod: ${detail}`
      );
    }
    return validation.plan;
  }
}
