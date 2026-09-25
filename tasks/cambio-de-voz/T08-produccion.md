# T08 — Producción: la key, el deploy y el QA con audio real

- **Depende de:** T07 en verde (`VOZ OK (mock)`, `UI OK`, build OK) y una API key de ElevenLabs
- **Bloquea:** nada. Es la última.
- **Se puede correr en paralelo con:** **nada. Va sola y última.**
- **Archivos que este task puede tocar:** §17 de `02-DISENO.md` (las resoluciones), `CHANGELOG.md` (el
  resultado del QA). En el server: `/srv/generador/shared/.env.production`. **Nada de `src/`.**

**Esto toca producción** (`generador.hilvanapp.online`, una sola instancia de PM2, proyectos con
videos de Veo ya pagados). Es la única task del módulo que lo hace.

---

## 1. Objetivo

- El cambio de voz anda en producción con ElevenLabs de verdad, con una key **restringida**.
- Un proyecto real corto (30-60 s) convertido y revisado **a ojo** por el usuario:
  - sincronía en los cortes entre clips y al final;
  - calidad de la voz;
  - volumen parejo (P-05).
- P-01, P-02 y P-03 resueltas en §17 con números. B40 en verde.

---

## 2. Runbook

```bash
# 0. El código está en main y T07 en verde. NO deployar con una generación ni una
#    conversión corriendo: un reload pierde lo que está en vuelo.

# 1. En elevenlabs.io: crear una API key RESTRINGIDA
#    - Speech to Speech: acceso
#    - Voices: lectura
#    - User: lectura (opcional: solo para mostrar créditos)
#    Si la cuenta lo permite, ponerle un límite de créditos a la key.

# 2. En el server, agregar a /srv/generador/shared/.env.production (chmod 600):
#      VOICE_PROVIDER=elevenlabs
#      ELEVENLABS_API_KEY=<la key>
#      # opcional, una por usuario: ELEVENLABS_API_KEY_IVAN=... / ELEVENLABS_API_KEY_LUCHO=...
#    y los valores que decidió T00 (§ "Decisiones" de _spike-resultados.md):
#      VOICE_OFFSET_MS=..  VOICE_BILLING=..  ELEVENLABS_OUTPUT_FORMAT=..  ELEVENLABS_TIMEOUT_MS=..
#    La key NO se pega en ningún chat, ticket ni commit.

# 3. Deploy (el guard 3f aborta si falta la key)
sudo -u deploy bash /srv/generador/repo/deploy/deploy.sh

# 4. QA (§3)
```

**Para revertir sin deploy:** `VOICE_PROVIDER=mock` en `.env.production` + `pm2 reload
generador-3006`. Las versiones ya hechas siguen en disco y se siguen viendo; solo deja de convertir.

---

## 3. QA con el usuario

| # | Qué | Esperado |
|---|---|---|
| 1 | Abrir un proyecto unido antes del módulo | Resultado dice "volvé a unir una vez" y "Cambiar voz" está deshabilitado con ese motivo |
| 2 | "Volver a unir" en un proyecto corto (< 60 s) | termina bien; "Cambiar voz" se habilita |
| 3 | "Cambiar voz" → Mis voces / Predeterminadas | aparecen las voces de la cuenta; las muestras se escuchan |
| 4 | Marcar una favorita con alias | aparece en Favoritas con el alias; la otra cuenta (Ivan/Lucho) **no** la ve |
| 5 | "Probar 20 s" | en ~1 min, un video de 20 s con la voz nueva; **sincronía a ojo** |
| 6 | Créditos antes y después de la prueba | la diferencia confirma o corrige P-01 (~333 o 1.000) |
| 7 | "Cambiar la voz de todo el video" | lista; sincronía en **cada corte** entre clips y al final; volumen parejo (P-05) |
| 8 | Descargar la versión | nombre `<proyecto>__voz-<voz>.mp4`; en el zip también aparece |
| 9 | Pestaña Red del navegador durante todo lo anterior | la key no aparece en ningún request ni response |
| 10 | El log del proyecto | inicio y fin de la conversión, sin la key |

---

## 4. Verificación

```bash
# en la maquina de desarrollo, con §17 actualizado
bash tasks/cambio-de-voz/_verificacion-voz.sh | tail -3
# esperado exactamente:  verde: 50   pendiente: 0   FALLO: 0   /   CAMBIO DE VOZ COMPLETO
```

§17 lleva, para P-01, P-02 y P-03, una línea `- **Resolución (<fecha>):** …` con el número medido.
Es la forma de las resoluciones del plan de aislamiento. Y en el CHANGELOG, el resultado del QA.

---

## 5. Cuándo parar

**Bloqueante: pará, revertí a `VOICE_PROVIDER=mock` y avisá.**

- La sincronía se ve mal en producción aunque el E2E en mock dio bien. Hay que medir el
  corrimiento real antes de seguir.
- La key aparece en cualquier respuesta, log o request del navegador.
- El deploy falla en un guard que no es el 3f.
