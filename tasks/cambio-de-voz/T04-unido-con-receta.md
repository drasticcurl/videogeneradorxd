# T04 — El unido con receta, y el 409 mientras hay una conversión

- **Depende de:** T01
- **Bloquea:** T05 (y todo lo que necesite un unido con receta para probarse)
- **Se puede correr en paralelo con:** T02, T03
- **Archivos que este task puede tocar:** `src/lib/ffmpeg.ts` (**solo** `StitchResult` y
  `stitchProject`), `src/app/api/projects/[id]/stitch/route.ts`. Nada más.

Leé `02-DISENO.md` completo. Tu contrato es **§7.1**, la fila del stitch en §11, y D6, D7 y D17.

---

## 1. Objetivo

- `stitchProject` devuelve `receta` cuando el stitch sale bien y hay ffprobe, con los tiempos que se
  midieron en §1.
- La ruta de stitch:
  - contesta **409** si hay una conversión viva (`corridaVivaDe`);
  - persiste la receta en `recetaUnido` cuando el stitch salió bien;
  - todo lo demás sigue igual.
- B22-B23 en verde, A1 y A5 siguen en verde.

**Todo lo que ya hacía el stitch se mantiene igual, byte por byte.** Este task agrega un dato a la
salida; no cambia el video que se produce.

---

## 2. Antes de escribir, leé

| Archivo | Qué mirar |
|---|---|
| `src/lib/ffmpeg.ts` | `stitchProject` completo (274-414): `ordered`, `clipMeta` (con `duration` de `probeDuration`), `ffprobeOk` |
| `02-DISENO.md` §1 | **por qué** `inicio(i) = Σ duración de formato`: el concat usa el stream más largo de cada clip |
| `src/app/api/projects/[id]/stitch/route.ts` | la ruta entera (33 líneas) y su guard de dueño (A1) |
| `src/lib/voz/estado.ts` (T01) | `corridaVivaDe` |
| `src/app/project/[id]/result/page.tsx` | `handleStitch` (202-237): qué campos de la respuesta lee la UI (`ok`, `finalPath`, `reason`). **No cambian** |

---

## 3. Qué hacer

### `stitchProject`

1. `StitchResult` suma `receta?: RecetaUnido`, con el comentario de para qué la usa el cambio de voz
   y por qué es opcional (sin ffprobe no se arma).
2. **Antes** del `runFfmpeg`, guardá en cada `clipMeta` el `mtimeMs` (`Math.trunc`) y el `size` de
   `fs.statSync` del clip. Antes y no después: la receta describe lo que ffmpeg leyó (§7.1 paso 1).
3. Si `res.status === 0 && ffprobeOk`, armá la receta según §7.1:
   - `inicioSeg`/`finSeg` acumulados de `clipMeta[i].duration`;
   - `conDialogo`, `assetId` y `etiqueta` desde el clip del manifest;
   - `file = finalRel`, `creadoEn` en ese momento, `duracionSeg` = `finSeg` del último.
4. **Nada más cambia.** Ni el grafo, ni los args, ni el preset, ni el mensaje de error.

### La ruta

```ts
// despues del guard y del projectsDb.get, ANTES de stitchProject:
const viva = corridaVivaDe(project);
if (viva) return ok({ ok: false, reason: "<texto de §11>" }, { status: 409 });
// ...
const result = stitchProject(project.id);
if (result.ok && result.receta) projectsDb.update(project.id, { recetaUnido: result.receta });
if (result.ok) await writeManifest(projectsDb.get(project.id)!, jobsDb.byProject(project.id));
return ok(result);
```

El `writeManifest` se hace con el proyecto **releído**, no con el `project` de antes del update. Así
queda una sola forma de leer el proyecto después de escribirlo (regla 3 de §10.2).

---

## 4. Verificación

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — los chequeos de T04 y los invariantes que toca
bash tasks/cambio-de-voz/_verificacion-voz.sh | grep -E '\[T04\]|A1 |A5 '
# esperado: B22, B23, A1 y A5 en OK

# 2 — el video que produce el stitch NO cambió: el grafo y los args son los mismos
#     (se buscan identificadores del STITCH; "-filter_complex_threads" es del helper de
#     cores que refactorizo T01 y no cuenta)
git diff src/lib/ffmpeg.ts | grep -E '^[-+].*(filterComplex|"libx264"|"-crf"|presetX264|concat=n=|"-shortest")' || echo "grafo intacto"
# esperado exactamente: grafo intacto

# 3 — la receta con ffmpeg real, fuera de la app. Con los 3 clips sinteticos de §1
#     (audio de c2 +60 ms, c3 -40 ms), la receta tiene que dar:
#       c1 0 -> 8   c2 8 -> 16.06   c3 16.06 -> 22.06   duracionSeg 22.06
#     y el tono de c3 tiene que arrancar en el unido en 16.06 (+ ~30 ms de retardo del
#     filtro de medicion). Script descartable en el scratchpad.

# 4 — typecheck
rm -rf .next && npx tsc --noEmit
```

La prueba del 409 con una conversión viva de verdad necesita la corrida (T03) y la ruta de voz (T05):
es el caso 5 del E2E de T07.

---

## 5. Cuándo parar

**Bloqueante, pará y avisá:**

- La receta de la verificación 3 no da los tiempos esperados. La fórmula de §7.1 está verificada en
  §1: si no da, algo del stitch se comporta distinto de lo medido.
- Hace falta tocar el grafo de ffmpeg para que la receta cierre. **No se toca**: cambiaría el video
  de todos los proyectos.

**Anotalo en §17 y seguí:** te parece que la receta debería guardar algo más (por ejemplo, el fps).
