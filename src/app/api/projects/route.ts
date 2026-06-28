/**
 * GET  /api/projects        -> lista de proyectos (resumen)
 * POST /api/projects        -> crea un proyecto a partir de { name?, brief, plan, models?, imageVariants? }
 */
import { randomUUID } from "node:crypto";
import { projectsDb } from "@/lib/db";
import { validatePlan } from "@/lib/schema";
import { resolveModel, resolveResolution, config } from "@/lib/config";
import { ensureProjectDirs, projectDir, writeManifest } from "@/lib/storage";
import { badRequest, ok, serverError } from "@/lib/http";
import type { ProjectRecord } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const projects = projectsDb.list().map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    clipCount: p.plan.clips.length,
    imageCount: p.plan.assets.reduce((a, asset) => a + asset.images.length, 0),
  }));
  return ok({ projects });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      name?: string;
      brief?: string;
      plan?: unknown;
      models?: { llm?: string; image?: string; video?: string };
      imageVariants?: number;
      defaultResolution?: string;
      autoApprove?: boolean;
      accent?: "arg" | "neutro";
    };

    const validation = validatePlan(body.plan);
    if (!validation.ok) {
      return badRequest("El plan no es valido.", validation.errors);
    }

    // El acento elegido en la UI (deslizable neutro/arg) manda sobre el plan: lo
    // fijamos en plan.global.acento para que la voz de los videos lo respete.
    if (body.accent === "arg" || body.accent === "neutro") {
      validation.plan.global.acento = body.accent;
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const name =
      (body.name && body.name.trim()) ||
      `Proyecto ${now.slice(0, 19).replace("T", " ")}`;

    const record: ProjectRecord = {
      id,
      name,
      brief: body.brief ?? "",
      plan: validation.plan,
      status: "draft",
      models: {
        llm: resolveModel("llm", body.models?.llm),
        image: resolveModel("image", body.models?.image),
        video: resolveModel("video", body.models?.video),
      },
      imageVariants: Math.min(
        4,
        Math.max(1, body.imageVariants ?? config.defaultImageVariants)
      ),
      defaultResolution: resolveResolution(body.defaultResolution),
      // Override per-proyecto del auto-approve. Si el cliente no manda nada,
      // dejamos undefined y la cola usa el default global (config.pipeline.autoApprove).
      autoApprove:
        typeof body.autoApprove === "boolean" ? body.autoApprove : undefined,
      outputDir: projectDir(id),
      createdAt: now,
      updatedAt: now,
    };

    projectsDb.upsert(record);
    await ensureProjectDirs(id);
    await writeManifest(record, []);

    return ok({ project: record }, { status: 201 });
  } catch (err) {
    return serverError(err);
  }
}
