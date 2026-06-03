---
inclusion: always
---

# Contexto del proyecto videogeneradorxd

Este steering carga automáticamente: dale al asistente **el estado actual** sin tener que repetirlo.

## Qué es

App Next.js **local** que genera anuncios UGC y **VSLs largos** (talking-head). Pegás un brief o
un PlanJSON, opcionalmente subís fotos de avatares (VSL), y la app genera imágenes + videos con
**Vertex AI** (Gemini, Nano Banana, Veo) manteniendo la **misma cara** en cada plano. Estado en
`./data/db.json` y archivos en `./output/<project_id>/`.

## Caso real activo

VSL "Agua de Arroz TURBO" — **Lic. Natalia Reyes** (foto real subida, único `reference`) +
**Romina** (testimonio, generada por IA con `text2image`). 95 clips en total (91 Natalia + 4
Romina). Plan completo en `vsl-natalia-plan.json` (raíz del repo); generador validado contra
Zod en `scripts/generate-vsl-plan.ts`.

## Estado actual (PRs #1–#16 mergeados)

- **VSL** (#9, #10): `ProjectPlan.references[]` (fotos subidas), `Image.ref_image_ids[]`
  (multi-persona), panel "Avatares de referencia" en home en ambos modos (IA y Pegar JSON),
  `id` de foto editable con indicador ✓/•, parser y provider Nano Banana inyectan multi-ref con
  instrucción de identidad.
- **Pipeline** (#12): **auto-aprobación** (default `PIPELINE_AUTO_APPROVE=true`) + **ventana
  rolling de 3** (`PIPELINE_CONCURRENCY=3`) — pensado para dejarlo toda la noche.
- **Resiliencia** (#11, #13):
  - 429 con backoff dedicado **45s** (respeta `Retry-After`) y **10 reintentos aparte** que no
    queman los `maxAttempts` normales.
  - Errores de red (`fetch failed`, timeouts) tratados como transitorios con backoff exp.
  - **Timeout 120s** por request de imagen.
  - **Variantes con éxito parcial**: 1 request por variante, persiste cada éxito al toque.
  - **Auto-recuperación**: jobs colgados en `generating` que no están realmente corriendo se
    resetean a `pending` cuando la cola se mueve.
  - **Cache-busting** `?v=<updatedAt>` + `key={url}` en `<img>`/`<video>`; al regenerar se
    limpia `outputPath` también para videos (antes el viejo quedaba pegado).
- **Vista de iteración** (#14, #15, #16):
  - Pestaña **🔧 Revisar / Arreglar** (lista compacta, video on-demand, no lagea con 95 clips).
  - **🔍 Revisar / editar seleccionados** abre un storyboard SOLO con los marcados.
  - Cada tarjeta muestra: imagen de entrada, **prompt visual editable**, **diálogo editable**,
    selector **duración 4/6/8**, prompt FINAL ejecutado (read-only, recalculable), JSON entero.
  - Botones: **💾 Guardar** (al plan, sin regenerar), **↻ Guardar y regenerar**, **↻ Regenerar
    todos sin editar**.
  - Si el proyecto tiene >24 clips, el pipeline arranca directo en esta vista.
  - El plan es la fuente de verdad → lo editado va al **export con ffmpeg**.

## Convenciones a respetar

- **Idioma**: español rioplatense ("vos") en chat y en los diálogos del VSL. Prompts visuales
  en inglés. Diálogos NO se traducen.
- **Modelos default**: chat `gemini-2.5-flash`, imagen `gemini-2.5-flash-image` (Nano Banana —
  más cuota / más barato; **NO** sugerir cambiar a Pro ante 429: tiene menos cuota), video
  `veo-3.1-generate-001`.
- **Formato**: vertical 9:16 fijo. **Duración** solo 4/6/8s (snap automático en backend).
- **Aprobaciones**: con `PIPELINE_AUTO_APPROVE=true` (default) los jobs se aprueban solos. Para
  modo manual: `PIPELINE_AUTO_APPROVE=false` + `PIPELINE_APPROVAL_BATCH=5` + botón "Aprobar lote".
- **PRs**: uno por feature/fix, siempre desde `main` actualizado. Título corto, body en español
  con secciones "Qué hace" / "Cambios" / "Tested" / "Notas".
- **Tests/build**: typecheck/build son lentos en este sandbox; el usuario suele pedir
  **saltearlos** y testear localmente. Confirmar antes de correrlos.
- **Preferencia**: cambios chicos y enfocados, con commits descriptivos en español. Nunca
  borrar funcionalidad existente sin avisar.

## Archivos importantes para orientarse

- `src/lib/config.ts` — `MODEL_CATALOG`, defaults, env vars de pipeline.
- `src/lib/schema.ts` — Zod del PlanJSON (`references[]`, `ref_image_ids[]`, validación cruzada).
- `src/lib/prompts.ts` — `PARSER_SYSTEM_PROMPT`, `buildVeoVideoPrompt` (UGC + acento argentino),
  `buildImageInstruction` (compartida con el provider, así el preview es idéntico a lo ejecutado).
- `src/lib/jobs/queue.ts` — auto-aprobación, gate por lotes, backoff 429+red, auto-recuperación.
- `src/lib/jobs/pipeline.ts` — `buildJobs`, `runImageGeneration`/`runVideoGeneration`, approve,
  changePrompt (guarda al plan), extend, concat.
- `src/app/project/[id]/pipeline/page.tsx` — pipeline UI con las 3 vistas y el storyboard de
  revisión editable.
- `vsl-natalia-plan.json` + `scripts/generate-vsl-plan.ts` — el VSL real listo para pegar.

## Pistas para no romper nada

- Cualquier cambio en el schema del plan: actualizar `validatePlan`, los tipos de `Manifest`,
  el parser system prompt, y el `responseSchema` de Vertex.
- Cualquier cambio en cómo se arma el prompt: hacerlo en `prompts.buildImageInstruction` o
  `buildVeoVideoPrompt` para que el provider y el endpoint `/api/jobs/:id/preview` queden
  alineados.
- En la cola, si el job termina OK y `autoApprove` está activo, hay que llamar `approveJob`
  (no dejar `awaiting_approval`).
- El export a ffmpeg lee del **plan**, no de los jobs: cualquier edición debe persistir en el
  plan vía `changePrompt` (eso ya está wireado desde la vista de revisión editable).
