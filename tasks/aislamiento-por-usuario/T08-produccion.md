# T08 — Producción: migrar los 12 proyectos, deployar y probarlo con las dos cuentas

- **Depende de:** T01, T02, T03, T04, T05, T06, T07 (**las siete en verde**, sin excepción)
- **Bloquea:** nada
- **Se puede correr en paralelo con:** **nada. Corre sola y última.**
- **Repo:** `/Users/lucho/Desktop/funnel/videogeneradorxd`
- **Archivos que este task puede tocar:** `CHANGELOG.md` y la §10 de
  `00-PLAN-AISLAMIENTO-USUARIO.md`. **Ningún archivo de `src/`.**

Leé `00-PLAN-AISLAMIENTO-USUARIO.md` completo, con atención a **§3** (las 7 garantías del script),
**§8** (criterios de aceptación) y **§9** (el runbook, que es lo que ejecutás).

**Esta task escribe en `db.json` de producción, donde viven ~12 proyectos con imágenes y videos ya
pagados.** El usuario dijo textual: *"no los quiero perder"*. Todo lo de abajo está ordenado alrededor
de eso.

---

## 1. Por qué esta task va sola y última

Si migrás con el filtro a medio implementar, los proyectos quedan con dueño pero se siguen viendo por
los caminos que falten — y no hay forma de saber cuáles faltaban, porque el síntoma (uno ve lo del
otro) es idéntico al estado anterior. La migración es el último paso, no el primero.

**Antes de tocar nada, la compuerta:**

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh | tail -3
# esperado exactamente: AISLAMIENTO COMPLETO
```

Si no dice eso, **pará**. Fijate qué quedó en `PENDIENTE`, avisá cuál es la task que falta, y no sigas.

---

## 2. Lo que NO hacés

- **No arreglás código.** Si la verificación encuentra algo, lo reportás y para ahí. Si vos parchás una
  ruta de T04, el dueño de ese archivo pierde el control de su diff y la próxima corrida de su
  verificación no se entiende.
- **No corrés `deploy.sh` sin confirmación explícita del usuario** (ver §5 y P-02 del plan).
- **No usás `--permitir-faltantes`** sin haber comparado a ojo los nombres que el script imprime.
- **No borrás ningún backup**, ni el que hace el script ni el manual.

---

## 3. Paso 1 — El estado de producción, antes

Estos números son la línea base de "no rompí nada" (§8, criterio 5). **Anotalos** antes de tocar nada:

```bash
# proyectos, jobs y logs que hay hoy
sudo -u deploy node -e '
  const db = require("/srv/generador/storage/data/db.json");
  console.log("proyectos:", Object.keys(db.projects).length);
  console.log("jobs:", Object.keys(db.jobs).length);
  console.log("logs:", Object.keys(db.logs).length);
  console.log("sin owner:", Object.values(db.projects).filter(p => !p.owner).length);
'
# esperado: ~12 proyectos, y "sin owner" IGUAL a la cantidad de proyectos
#   (nadie tiene dueño todavia). Anota los 4 numeros.

# carpetas en disco
sudo -u deploy ls -1 /srv/generador/storage/output | wc -l
# anota el numero. La migracion NO lo tiene que cambiar.
```

**Backup manual, además del que hace el script.** Cuesta un segundo:

```bash
sudo -u deploy cp /srv/generador/storage/data/db.json \
     /srv/generador/storage/data/db.json.manual-$(date +%Y%m%d%H%M%S)
```

---

## 4. Paso 2 — El `--dry-run`, que es donde de verdad se decide

```bash
sudo -u deploy node /srv/generador/repo/scripts/migrar-owner.mjs \
     --db /srv/generador/storage/data/db.json --dry-run
```

**Leé la tabla completa antes de seguir.** Tres cosas que tenés que confirmar a ojo, y ninguna la puede
confirmar el script solo:

1. **Que los 4 proyectos de Ivan aparezcan**, con `dueño = ivan`. Son:
   `AA_rendicion_meresigne_duena52_v02`, `AA_rendicion_meresigne_duena52_v01`,
   `AA_alquiler_marcodepuerta_duena31_v01`, `AA_manerastontas_multivoz_v01`.
   **Estos nombres nunca se pudieron verificar contra la DB real** (P-01 del plan): se transcribieron de
   un mensaje. Si el script aborta diciendo que falta uno, **compará carácter por carácter** contra la
   lista de nombres reales que imprime al lado. Si es un typo del mensaje, avisale al usuario con los
   dos nombres y **esperá**: no adivines.
2. **Que el resto vaya a `lucho`** y que el total sea el que anotaste en el paso 1.
3. **Si aparece un `AVISO:` de que algún proyecto de Ivan es de "solo imágenes"** — el usuario dijo
   *"las imágenes, todas a lucho"* y también nombró esos 4. Gana la lista explícita (P-03), pero
   **avisale igual** antes de escribir: puede que se haya confundido de nombre.

---

## 5. Paso 3 — Migrar

```bash
sudo -u deploy node /srv/generador/repo/scripts/migrar-owner.mjs \
     --db /srv/generador/storage/data/db.json
```

Y verificá **inmediatamente** que no se perdió nada:

```bash
sudo -u deploy node -e '
  const db = require("/srv/generador/storage/data/db.json");
  const por = {};
  for (const p of Object.values(db.projects)) por[p.owner ?? "SIN_DUEÑO"] = (por[p.owner ?? "SIN_DUEÑO"] ?? 0) + 1;
  console.log("proyectos:", Object.keys(db.projects).length);
  console.log("jobs:", Object.keys(db.jobs).length);
  console.log("logs:", Object.keys(db.logs).length);
  console.log("por dueño:", por);
'
# esperado exactamente: proyectos, jobs y logs IGUALES a los del paso 1,
#                       por dueño: { ivan: 4, lucho: <el resto> }, y NINGUN "SIN_DUEÑO"

sudo -u deploy ls -1 /srv/generador/storage/output | wc -l
# esperado exactamente: el mismo numero del paso 1. La migracion no toca el disco.
```

**Si algún número no coincide: restaurá el backup y pará.**

```bash
# solo si algo salio mal
sudo -u deploy cp /srv/generador/storage/data/db.json.bak-<el que imprimio el script> \
                  /srv/generador/storage/data/db.json
```

Y probá la idempotencia, que es gratis y confirma que el script quedó bien copiado:

```bash
sudo -u deploy node /srv/generador/repo/scripts/migrar-owner.mjs \
     --db /srv/generador/storage/data/db.json
# esperado exactamente: "nada que hacer: todos los proyectos ya tenian dueño."
```

---

## 6. Paso 4 — Deploy. **Acá se para y se pide confirmación.**

**La migración va ANTES del deploy a propósito** (D11): el código que está corriendo ignora `owner`,
así que entre el paso 3 y el 5 nadie ve nada distinto. Al revés habría una ventana con los 12
proyectos invisibles para todos.

Dos cosas que este task **no puede dar por hechas** (P-02 del plan):

1. **El código tiene que estar commiteado y pusheado a `main`.** `deploy.sh` hace
   `git fetch origin main` + `git reset --hard origin/main`: lo que esté sin pushear **no se deploya**,
   y el script no avisa — construye la release con el commit viejo y el health check pasa igual.
2. **Hace falta acceso al server.** El script corre **en** `/srv/generador`, como usuario `deploy`.

Entonces: **pará acá**, mostrale al usuario el estado (qué está pusheado, qué no) y el comando, y
**esperá que confirme**:

```bash
sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh
```

Recordale, en una línea: **un reload reinicia el proceso y los jobs en vuelo se pierden** (los archivos
ya escritos quedan, el progreso no). Si hay una generación corriendo, se espera.

---

## 7. Paso 5 — QA con las dos cuentas. Es el criterio 6 de §8 y no se saltea

Con la app ya deployada, y **entrando de verdad con las dos passwords**. Cada punto tiene un resultado
esperado concreto:

| # | Qué hacer | Esperado |
|---|---|---|
| 1 | Entrar como `lucho`, mirar `/` | los proyectos de video de Lucho. **Ninguno de los 4 de Ivan** |
| 2 | Como `lucho`, mirar `/imagenes` | las tandas de imágenes de Lucho |
| 3 | Copiar el id de un proyecto de Lucho. Salir, entrar como `ivan`, mirar `/` | **solo los 4 suyos** |
| 4 | Como `ivan`, ir a `/batch?ids=<id de Lucho>` | el cartel de no disponibles, con el id listado. **Cero miniaturas** |
| 5 | Como `ivan`, pegar `/api/files/<id de Lucho>/manifest.json` | **404** |
| 6 | Como `ivan`, `/project/<id de Lucho>/pipeline` | mensaje legible, no pantalla en blanco |
| 7 | Como `ivan`, `POST /api/jobs/<id de Lucho>:img:<cualquier cosa>/approve` | **404** |
| 8 | Como `ivan`, crear un proyecto nuevo y generar en modo mock o real | funciona igual que antes |
| 9 | Volver a `lucho` | sigue viendo **todo lo suyo**, con sus imágenes y videos visibles |

El punto 9 es el que importa más: **el objetivo era aislar, no perder.** Si a Lucho le falta un
proyecto, restaurá el backup del paso 3 y avisá.

Para el punto 7, el comando exacto (la cookie sale del browser, pestaña de red):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Cookie: gen_session=<la cookie de ivan>' \
  'https://generador.hilvanapp.online/api/jobs/<projectId de lucho>:img:algo/approve'
# esperado exactamente: 404
```

---

## 8. Paso 6 — Dejar registro

En `CHANGELOG.md`, arriba, una entrada con la fecha real del deploy: qué cambió, los números
antes/después de la migración (los del paso 3), y las preguntas que quedaron abiertas. El formato está
en el archivo.

En **§10 del plan**, cerrá las preguntas que se resolvieron: P-01 (si los 4 nombres coincidían), P-02
(cómo se corrió el deploy) y P-03 (si alguno de los 4 era de solo imágenes). Poné la resolución, no las
borres: sirve para entender por qué el script quedó como quedó.

---

## 9. Verificación

Nada de esto es opcional. Un task que no corre su verificación no está terminado, y "compila" no es
verificación. Los pasos 1 y 2 se corren **antes** de tocar producción; los demás, después.

```bash
cd /Users/lucho/Desktop/funnel/videogeneradorxd

# 1 — LA COMPUERTA. Sin esto no arranca nada de esta task.
bash tasks/aislamiento-por-usuario/_verificacion-aislamiento.sh | tail -3
# esperado exactamente: AISLAMIENTO COMPLETO
#   (verde: 31   pendiente: 0   FALLO: 0)

# 2 — las afirmaciones de la migracion siguen en verde, y el script copiado es identico
node tasks/aislamiento-por-usuario/_verificacion-migracion.mjs | tail -1
# esperado exactamente: TODO EN VERDE (7/7)
diff tasks/aislamiento-por-usuario/_migracion-owner.mjs scripts/migrar-owner.mjs && echo "identico"
# esperado exactamente: identico

# 3 — nada de lo que ya funcionaba cambio
bash tasks/_verificacion-endpoints.sh | tail -1
# esperado exactamente: SIN REGRESIONES
```

En el server, **después** de la migración (paso 3 de esta task) y **después** del deploy:

```bash
# 4 — los conteos de db.json no cambiaron, y no quedo nadie sin dueño
sudo -u deploy node -e '
  const db = require("/srv/generador/storage/data/db.json");
  const por = {};
  for (const p of Object.values(db.projects)) por[p.owner ?? "SIN_DUEÑO"] = (por[p.owner ?? "SIN_DUEÑO"] ?? 0) + 1;
  console.log(Object.keys(db.projects).length, Object.keys(db.jobs).length, Object.keys(db.logs).length, JSON.stringify(por));
'
# esperado exactamente: los 3 numeros IGUALES a los que anotaste en el paso 1 de esta task,
#                       y el objeto con {"ivan":4,"lucho":<resto>}, SIN la clave "SIN_DUEÑO"

# 5 — el disco no se toco
sudo -u deploy ls -1 /srv/generador/storage/output | wc -l
# esperado exactamente: el mismo numero que anotaste en el paso 1

# 6 — hay backup, y se sabe cual
sudo -u deploy ls -1t /srv/generador/storage/data/db.json.bak-* \
                      /srv/generador/storage/data/db.json.manual-* 2>/dev/null | head -2
# esperado: dos archivos (el del script y el manual). Si no hay ninguno, PARA.

# 7 — la app quedo arriba
curl -s -o /dev/null -w '%{http_code}\n' https://generador.hilvanapp.online/login
# esperado exactamente: 200

# 8 — un projectId ajeno no sirve para bajar archivos (la fuga mas directa)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Cookie: gen_session=<la cookie de ivan>' \
  'https://generador.hilvanapp.online/api/files/<projectId de lucho>/manifest.json'
# esperado exactamente: 404
```

Y **el QA a mano de §7: los 9 puntos con las dos cuentas.** No se puede verificar con `curl` solo,
porque lo que hay que ver es qué lista cada uno en la pantalla. El punto 9 (*"Lucho sigue viendo todo
lo suyo"*) es el que decide si el módulo se puede dar por bueno.

---

## 10. Cuándo parar

**Bloqueante, pará y avisá:**

- `_verificacion-aislamiento.sh` no dice `AISLAMIENTO COMPLETO`. Falta una task.
- El script de migración **aborta** porque no encuentra uno de los 4 nombres de Ivan. **No uses
  `--permitir-faltantes` para salir del paso.** Mostrale al usuario el nombre esperado y el real.
- Cualquier conteo del paso 3 (proyectos, jobs, logs, carpetas) **no coincide**. Restaurá el backup y
  avisá. Esto es "se perdieron proyectos", que es la única cosa que el usuario pidió que no pase.
- El health check del deploy falla y `deploy.sh` hace rollback solo. El código volvió atrás pero **la
  migración ya está aplicada**: no es grave (el código viejo ignora `owner`), pero decilo claramente
  porque el estado es mixto.
- El QA falla en el punto 9: a Lucho le falta algo suyo.

**Anotalo en §10 del plan y seguí:**

- Un proyecto quedó con un dueño que al usuario le parece raro pero no está en los 4 nombres. Anotalo:
  se arregla con otra corrida del script y `--default-owner`.
- Algo del QA anda pero se siente raro (un cartel poco claro, una lista vacía sin explicación).
- Necesitás modificar un archivo de `src/` → **nunca**; anotalo y avisá de quién es la task.
