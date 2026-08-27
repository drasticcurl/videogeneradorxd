/**
 * PM2 — el generador. UNA sola instancia.
 *
 * Instalar/actualizar:
 *   pm2 start /srv/generador/repo/deploy/ecosystem.config.js
 *   pm2 save        # persiste la lista para el reboot. Sin esto, un reboot
 *                   # levanta la VPS sin el generador.
 *
 * ─── POR QUE UNA SOLA INSTANCIA (y no dos como los funnels) ─────────────────
 *
 * La cola de jobs vive en la MEMORIA del proceso (src/lib/jobs/queue.ts), no en
 * la base. Con dos instancias detras de un balanceador:
 *   - el POST que encola un proyecto cae en la instancia A y la cola arranca ahi;
 *   - el GET que la UI pollea para ver el progreso cae en la B, que no sabe nada
 *     de esos jobs y contesta que no hay nada corriendo;
 *   - las dos escriben el mismo data/db.json y se pisan las escrituras.
 * El sintoma seria "generé y no pasa nada" de forma intermitente. No hay que
 * subir `instances` sin antes mover la cola a un store compartido.
 *
 * El rate limit del login (src/lib/auth.ts) tambien es in-memory, asi que con N
 * instancias el limite efectivo se multiplica por N.
 *
 * `exec_mode: 'fork'` y no cluster por lo mismo: en cluster las instancias
 * comparten el puerto y aca hace falta un proceso unico.
 *
 * `HOSTNAME: '127.0.0.1'` es OBLIGATORIO: el server.js del build standalone
 * bindea 0.0.0.0 por default. Sin esto el generador escucha en todas las
 * interfaces y se puede llegar salteando a Caddy, o sea salteando el login. Es
 * una app que gasta plata: que no pase.
 *
 * Las env vars de la app NO van aca: las lee Next del .env.production que
 * deploy.sh instala dentro de .next/standalone/.
 */

module.exports = {
  apps: [
    {
      name: 'generador-3006',
      script: 'server.js',
      cwd: '/srv/generador/current',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        PORT: '3006',
        HOSTNAME: '127.0.0.1',
      },
      autorestart: true,
      /**
       * 2 GB es alto a proposito. La app baja los videos de Veo como base64 y los
       * pasa a Buffer, asi que con PIPELINE_CONCURRENCY=3 el pico legitimo son
       * varios cientos de MB. Un limite ajustado reiniciaria el proceso en medio
       * de una generacion, y como la cola es in-memory, ese reinicio PIERDE los
       * jobs en vuelo (los archivos ya escritos quedan, el progreso no). El
       * limite existe solo para atajar un leak de verdad.
       * La VPS tiene ~6 GB libres, asi que 2 GB no compite con los funnels.
       */
      max_memory_restart: '2G',
      // Un bug deterministico al arrancar no puede convertirse en un ciclo de
      // reinicios que llene /var/log/pm2 en horas.
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      out_file: '/var/log/pm2/generador-3006.out.log',
      error_file: '/var/log/pm2/generador-3006.err.log',
      time: true,
    },
  ],
};
