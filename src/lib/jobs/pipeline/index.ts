/**
 * Pipeline del proyecto: construccion, ejecucion, aprobacion y edicion de jobs.
 *
 * Barrel: re-exporta la API publica para que `@/lib/jobs/pipeline` siga funcionando
 * tras fragmentar el modulo. Cada archivo tiene una responsabilidad:
 *   - shared.ts    ids de jobs, lookup de imagenes, logging, refreshManifest
 *   - build.ts     buildJobs (crea/re-crea jobs desde el plan)
 *   - generate.ts  runJobGeneration + runImage/runVideo (ejecuta contra el provider)
 *   - edit.ts      approveJob, changePrompt, extendVideoJob
 *   - cost.ts      estimateCost
 */
export { imageJobId, videoJobId, logEvent, refreshManifest } from "./shared";
export { buildJobs } from "./build";
export { runJobGeneration } from "./generate";
export { approveJob, changePrompt, extendVideoJob } from "./edit";
export { estimateCost } from "./cost";
